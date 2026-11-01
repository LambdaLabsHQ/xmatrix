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

/// Asks this Machine's daemon, through the Hub, to probe its harnesses again
/// and report them, and waits for its answer (at most two minutes). This is
/// how a change an Agent made here reaches the Hub's view of the Machine.
async fn refresh_own_machine_inventory(
    hub_url: &str,
    token: &str,
    machine_id: &str,
) -> error::Result<serde_json::Value> {
    let actions = format!("{}/api/machine-daemons/harness-actions", hub_url.trim_end_matches('/'));
    let queued: serde_json::Value = xmatrix_cli_core::http::request_json(
        &actions,
        "POST",
        Some(token),
        Some(serde_json::json!({ "machineId": machine_id, "presetId": "custom", "action": "refresh" })),
    )
    .await?;
    let control = queued
        .get("controlId")
        .and_then(|value| value.as_str())
        .filter(|id| id.starts_with("harness:"))
        .ok_or_else(|| CliError::Launch("The Hub did not queue the refresh".into()))?
        .replace(':', "%3A");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let status: serde_json::Value = xmatrix_cli_core::http::request_json(
            &format!("{actions}/{control}"),
            "GET",
            Some(token),
            None,
        )
        .await?;
        match status.get("status").and_then(|value| value.as_str()) {
            Some("queued" | "running") => continue,
            Some("succeeded") => return Ok(status),
            _ => {
                return Err(CliError::Launch(format!(
                    "the refresh ended {}",
                    status.get("error").and_then(|value| value.as_str()).unwrap_or("without a result")
                )));
            }
        }
    }
    Err(CliError::Launch("the Machine did not answer the refresh within two minutes".into()))
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

/// Posts a request card for this Agent's Channel with its reason. A retry of
/// the same request replays its card; another request is a new one.
async fn post_request_card(
    hub_url: &str,
    token: &str,
    route: &str,
    mut body: serde_json::Value,
    reason: Option<String>,
) -> error::Result<serde_json::Value> {
    body["requestId"] = uuid::Uuid::new_v4().to_string().into();
    if let Some(reason) = reason.map(|reason| reason.trim().to_string()).filter(|reason| !reason.is_empty()) {
        body["reason"] = reason.into();
    }
    xmatrix_cli_core::http::request_json(
        &xmatrix_cli_core::protocol::with_route(hub_url, route),
        "POST",
        Some(token),
        Some(body),
    )
    .await
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
    // On its own Machine the Agent may have just installed the harness: have
    // the daemon look again first, so the card and its check see it.
    let local_id = xmatrix_cli_core::config::get_or_create_machine_identity(hub_url)
        .await?
        .machine_id;
    if machine_id.as_deref().is_none_or(|id| id == local_id)
        && let Err(err) = refresh_own_machine_inventory(hub_url, token, &local_id).await
    {
        eprintln!("This Machine's daemon did not look at its harnesses again ({err}); asking with its last check.");
    }
    let mut body = serde_json::json!({ "harness": harness.trim() });
    if let Some(machine_id) = machine_id {
        body["machineId"] = machine_id.into();
    }
    let posted = post_request_card(
        hub_url,
        token,
        xmatrix_cli_core::protocol::HubRoutes::HARNESS_SIGN_IN_REQUESTS,
        body,
        reason,
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

/// How often `request settings --wait` reads where the settings stand, and for how long.
const SETTINGS_WAIT_POLL: std::time::Duration = std::time::Duration::from_secs(5);
const SETTINGS_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The status URL for these settings, asked for at `since`.
fn settings_status_url(hub_url: &str, settings: &[String], since: &str) -> String {
    let mut url = xmatrix_cli_core::protocol::with_route(
        hub_url,
        xmatrix_cli_core::protocol::HubRoutes::SETTINGS_REQUEST_STATUS,
    );
    let query = settings
        .iter()
        .map(|setting| format!("setting={}", urlencoding::encode(setting)))
        .chain(std::iter::once(format!("since={}", urlencoding::encode(since))))
        .collect::<Vec<_>>()
        .join("&");
    url.push('?');
    url.push_str(&query);
    url
}

/// Asks a Space admin, on a card in this Agent's Channel, for connector
/// settings; with `wait`, returns once each is in and its connection checked.
async fn cmd_request_settings(
    hub_url: &str,
    token: &str,
    settings: Vec<String>,
    reason: Option<String>,
    wait: bool,
    json: bool,
) -> error::Result<()> {
    let settings: Vec<String> = settings.iter().map(|setting| setting.trim().to_string()).collect();
    let posted = post_request_card(
        hub_url,
        token,
        xmatrix_cli_core::protocol::HubRoutes::SETTINGS_REQUESTS,
        serde_json::json!({ "settings": settings }),
        reason,
    )
    .await?;
    let asked: Vec<String> = posted["settings"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or(settings);
    if !wait {
        if json {
            println!("{posted}");
        } else {
            println!(
                "Asked a Space admin, on a card in this Channel, for {}. Run again with --wait to return once they are in.",
                asked.join(", ")
            );
        }
        return Ok(());
    }
    let since = posted["askedAt"].as_str().unwrap_or_default().to_string();
    let url = settings_status_url(hub_url, &asked, &since);
    let started = std::time::Instant::now();
    if !json {
        eprintln!("Asked a Space admin for {}; waiting for them on the card…", asked.join(", "));
    }
    loop {
        let status: serde_json::Value =
            xmatrix_cli_core::http::request_json(&url, "GET", Some(token), None).await?;
        if status["settled"].as_bool() == Some(true) {
            if json {
                println!("{status}");
            } else {
                println!("Every setting is in and its connection passed a check: {}.", asked.join(", "));
            }
            return Ok(());
        }
        if started.elapsed() >= SETTINGS_WAIT_LIMIT {
            if json {
                println!("{status}");
            }
            return Err(CliError::Launch(format!(
                "No one has made {} yet; the card stays in the Channel. Ask again with --wait to keep waiting.",
                asked.join(", ")
            )));
        }
        tokio::time::sleep(SETTINGS_WAIT_POLL).await;
    }
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
        // recipe here itself, as its owner would. Then this Machine's daemon
        // looks again and reports, so routing and sign-in see what changed.
        if action != "refresh" {
            apply_harness_locally(preset_id, action).await?;
        }
        let token = resolve_auth_token(token_override, hub_url).await?;
        return match refresh_own_machine_inventory(hub_url, &token, &local_id).await {
            Ok(status) if action == "refresh" => {
                println!("{}", status.get("result").unwrap_or(&status));
                Ok(())
            }
            Ok(_) => Ok(()),
            // A Hub or daemon that cannot take the refresh still has the local probe.
            Err(err) if action == "refresh" => {
                eprintln!("This Machine's daemon did not look again ({err}); probing here only.");
                apply_harness_locally(preset_id, action).await
            }
            Err(err) => {
                eprintln!(
                    "Done here, but this Machine's daemon did not look again, so xMatrix still shows its last check: {err}"
                );
                Ok(())
            }
        };
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
    fn settings_status_names_each_setting_and_when_they_were_asked_for() {
        let url = settings_status_url(
            "https://hub.example",
            &[
                "connector:appstoreconnect/webSession".to_string(),
                "connector:googleplay/connect".to_string(),
            ],
            "2026-11-01T10:00:00.000Z",
        );
        assert_eq!(
            url,
            "https://hub.example/api/settings-requests/status?setting=connector%3Aappstoreconnect%2FwebSession\
             &setting=connector%3Agoogleplay%2Fconnect&since=2026-11-01T10%3A00%3A00.000Z"
        );
    }
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
