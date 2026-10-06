use super::*;
use xmatrix_cli_core::protocol;

/// The owner of the Run this CLI runs inside, from its registration.
fn run_owner_user_id() -> Option<String> {
    let registration: Value =
        serde_json::from_str(&std::env::var("XMATRIX_AGENT_REGISTRATION").ok()?).ok()?;
    registration["ownerUserId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A Space's Agents are its registrations: one harness on one owner's machine.
/// Inside a Run, an Agent lists its Space's Agents and adds one for its owner
/// on its own machine, as the owner would; the rest stays with people.
pub(super) async fn run(hub_url: &str, token: &str, command: AgentCommand) -> error::Result<()> {
    let run_owner = if access::inside_agent_run() {
        if !matches!(
            command,
            AgentCommand::List { .. } | AgentCommand::Add { .. }
        ) {
            return Err(CliError::Launch(
                "Inside an Agent Run, `xmatrix agent` lists and adds Agents; the owner changes or removes them".into(),
            ));
        }
        Some(run_owner_user_id().ok_or_else(|| {
            CliError::Launch("This Run has no registration to add an Agent for".into())
        })?)
    } else {
        None
    };
    match command {
        AgentCommand::List { space } => list(hub_url, token, &space).await,
        AgentCommand::Add {
            harness,
            space,
            name,
            runtime,
            args,
            workspace,
        } => {
            let owner_user_id = match run_owner {
                Some(owner) => owner,
                None => {
                    config::load_session_for_hub(hub_url)
                        .await
                        .ok_or_else(|| {
                            CliError::Auth(
                                "Log in as the machine owner before adding its Agent".into(),
                            )
                        })?
                        .user
                        .id
                }
            };
            let preset = concrete_preset(&harness)?;
            let runtime = runtime.unwrap_or_else(|| preset.runtime.clone());
            if !runtime_available_for_preset(&runtime, preset) {
                eprintln!(
                    "{} {runtime} is not installed on this machine yet{}",
                    "!".yellow(),
                    runtime_install_hint(&runtime)
                        .map(|hint| format!(": {hint}"))
                        .unwrap_or_default()
                );
            }
            let key = space_key(
                &space,
                owner_user_id,
                config::get_or_create_machine_id(hub_url).await?,
                preset.id.clone(),
            );
            // The Agent is granted the owner's Workspaces on this machine, so a
            // default directory that is not one yet is registered first.
            let default_workspace = match workspace {
                Some(path) => Some(
                    xmatrix_cli_workspace::ensure_workspace(hub_url, token, &path)
                        .await?
                        .location
                        .canonical_cwd,
                ),
                None => None,
            };
            let body = add_command(
                &key,
                name.unwrap_or_else(|| preset.id.clone()),
                AgentLaunch {
                    runtime,
                    args: if args.is_empty() {
                        preset.default_args.clone()
                    } else {
                        args
                    },
                    backend: preset.backend.clone(),
                },
                default_workspace,
            );
            // Adding it again grants Workspaces registered here since, and adds
            // back an Agent that was removed from the Space.
            let result = command_request(hub_url, token, &space, body).await?;
            println!(
                "{} Added {} to Space {} (version {})",
                "✓".green(),
                key["harness"].as_str().unwrap_or_default().bold(),
                space,
                result["version"]
            );
            // Its Runs start on this machine, so its daemon must be up.
            ensure_local_daemon_started(hub_url, token).await
        }
        AgentCommand::Show {
            harness,
            space,
            owner,
            machine,
            connections,
        } => {
            let key = resolve_key(hub_url, &space, owner, machine, harness).await?;
            let mut value = details(hub_url, token, &space, &key).await?;
            if connections {
                let route = format!(
                    "/api/spaces/{}/app-connections",
                    urlencoding::encode(&space)
                );
                let catalog: Value =
                    http::request_json(&with_route(hub_url, &route), "GET", Some(token), None)
                        .await?;
                value["connections"] = Value::Array(
                    catalog["connections"]
                        .as_array()
                        .ok_or_else(|| CliError::Launch("Invalid connector catalog".into()))?
                        .iter()
                        .map(|item| {
                            serde_json::json!({"id":item["id"],"providerId":item["providerId"],
                                "status":item["status"],"version":item["version"]})
                        })
                        .collect(),
                );
            }
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        AgentCommand::Remove {
            harness,
            space,
            owner,
            machine,
        } => {
            let key = resolve_key(hub_url, &space, owner, machine, harness).await?;
            let current = details(hub_url, token, &space, &key).await?;
            let body = remove_command(&key, &current)?;
            command_request(hub_url, token, &space, body).await?;
            println!(
                "{} Removed {} from Space {}",
                "✓".green(),
                current["displayName"].as_str().unwrap_or_default().bold(),
                space
            );
            Ok(())
        }
        AgentCommand::Disable {
            harness,
            space,
            owner,
            machine,
        } => set_space_state(hub_url, token, &space, owner, machine, harness, false).await,
        AgentCommand::Enable {
            harness,
            space,
            owner,
            machine,
        } => set_space_state(hub_url, token, &space, owner, machine, harness, true).await,
        AgentCommand::Discover { .. } => unreachable!("discovery is local"),
    }
}

async fn list(hub_url: &str, token: &str, space: &str) -> error::Result<()> {
    let value: Value = http::request_json(
        &with_route(hub_url, &protocol::space_agent_registrations_route(space)),
        "GET",
        Some(token),
        None,
    )
    .await?;
    let registrations = value["registrations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if registrations.is_empty() {
        println!(
            "No Agents in Space {space}. Add one with `xmatrix agent add <harness> --space {space}`."
        );
        return Ok(());
    }
    println!(
        "{:<24} {:<10} {:<20} {:<20} {}",
        "NAME".bold(),
        "HARNESS".bold(),
        "OWNER".bold(),
        "MACHINE".bold(),
        "STATE".bold()
    );
    for registration in &registrations {
        let text = |value: &Value| value.as_str().unwrap_or("-").to_string();
        println!(
            "{:<24} {:<10} {:<20} {:<20} {}",
            text(&registration["displayName"]),
            text(&registration["key"]["harness"]),
            text(&registration["ownerName"]),
            text(&registration["machineName"]),
            state_label(registration)
        );
    }
    Ok(())
}

/// Disabled in the Space, or (before disabling was per Space) on its machine.
fn state_label(registration: &Value) -> String {
    if registration["routingBlocker"].as_str() == Some("owner_environment_disabled") {
        return "disabled".to_string();
    }
    registration["state"].as_str().unwrap_or("-").to_string()
}

/// The Agent's owner or a Space owner/admin disables or enables it in a Space.
async fn set_space_state(
    hub_url: &str,
    token: &str,
    space: &str,
    owner: Option<String>,
    machine: Option<String>,
    harness: String,
    enabled: bool,
) -> error::Result<()> {
    let key = resolve_key(hub_url, space, owner, machine, harness).await?;
    let current = details(hub_url, token, space, &key).await?;
    let body = space_state_command(&key, &current, enabled)?;
    command_request(hub_url, token, space, body).await?;
    println!(
        "{} {} {} in Space {}",
        "✓".green(),
        if enabled { "Enabled" } else { "Disabled" },
        current["displayName"].as_str().unwrap_or_default().bold(),
        space
    );
    Ok(())
}

fn space_state_command(key: &Value, current: &Value, enabled: bool) -> error::Result<Value> {
    if current["canConfigureSpace"].as_bool() != Some(true)
        && current["canManageOwnerGrant"].as_bool() != Some(true)
    {
        return Err(CliError::Launch(
            "Only the Agent's owner or a Space owner or admin can disable or enable it".into(),
        ));
    }
    let revision = current["access"]["policy"]["revision"]
        .as_u64()
        .ok_or_else(|| CliError::Launch("The Agent's Space access is unavailable".into()))?;
    Ok(serde_json::json!({
        "action": "space-state",
        "commandId": format!("registration-space-state:{}", uuid::Uuid::new_v4()),
        "key": key,
        "state": if enabled { "enabled" } else { "disabled" },
        "expectedRevision": revision,
    }))
}

fn concrete_preset(harness: &str) -> error::Result<&'static AgentPreset> {
    agent_preset_by_id(harness)
        .filter(|preset| preset.id != "custom")
        .ok_or_else(|| {
            CliError::Launch(format!(
                "Choose a supported harness: {}",
                known_agent_preset_ids()
            ))
        })
}

fn space_key(space: &str, owner: String, machine: String, harness: String) -> Value {
    serde_json::json!({"spaceId": space, "ownerUserId": owner, "machineId": machine, "harness": harness})
}

/// An omitted owner is the caller and an omitted machine is this one.
async fn resolve_key(
    hub_url: &str,
    space: &str,
    owner: Option<String>,
    machine: Option<String>,
    harness: String,
) -> error::Result<Value> {
    let owner = match owner {
        Some(owner) => owner,
        None => {
            config::load_session_for_hub(hub_url)
                .await
                .ok_or_else(|| CliError::Auth("Log in, or name the Agent's --owner".into()))?
                .user
                .id
        }
    };
    let machine = match machine {
        Some(machine) => machine,
        None => config::get_or_create_machine_id(hub_url).await?,
    };
    Ok(space_key(space, owner, machine, harness))
}

struct AgentLaunch {
    runtime: String,
    args: Vec<String>,
    backend: String,
}

/// The Hub's `create` command: declare the harness on this machine, offer it
/// to the Space, grant it the owner's Workspaces here, and enable it.
fn add_command(
    key: &Value,
    name: String,
    launch: AgentLaunch,
    default_workspace: Option<String>,
) -> Value {
    let mut launch_json = serde_json::json!({
        "runtime": launch.runtime,
        "runtimeArgs": launch.args,
    });
    if !launch.backend.trim().is_empty() {
        launch_json["backend"] = Value::String(launch.backend);
    }
    let mut body = serde_json::json!({
        "action": "create",
        "commandId": format!("registration-create:{}", uuid::Uuid::new_v4()),
        "key": key,
        "displayName": name,
        "environment": {
            "schemaVersion": 1,
            "enabled": true,
            "models": [],
            "description": "",
            "availability": "unknown",
            "capabilities": [],
            "launch": launch_json,
        },
    });
    if let Some(path) = default_workspace {
        body["defaultWorkspace"] = Value::String(path);
    }
    body
}

/// Removing an Agent from a Space revokes its owner's grant there, which its
/// owner or a Space admin may do.
fn remove_command(key: &Value, current: &Value) -> error::Result<Value> {
    if current["canRemoveFromSpace"].as_bool() != Some(true) {
        return Err(CliError::Launch(
            "Only the Agent's owner or a Space admin can remove it from this Space".into(),
        ));
    }
    let grant = &current["access"]["grant"];
    let revision = grant["revision"]
        .as_u64()
        .ok_or_else(|| CliError::Launch("The Agent's access grant is unavailable".into()))?;
    Ok(serde_json::json!({
        "action": "owner-grant",
        "commandId": format!("registration-remove:{}", uuid::Uuid::new_v4()),
        "key": key,
        "state": "revoked",
        "expectedRevision": revision,
        "limits": grant["limits"],
    }))
}

async fn details(hub_url: &str, token: &str, space: &str, key: &Value) -> error::Result<Value> {
    let route = protocol::space_agent_registration_query_route(space);
    http::request_json(
        &with_route(hub_url, &route),
        "POST",
        Some(token),
        Some(key.clone()),
    )
    .await
}

async fn command_request(
    hub_url: &str,
    token: &str,
    space: &str,
    body: Value,
) -> error::Result<Value> {
    let route = protocol::space_agent_registration_command_route(space);
    http::request_json(
        &with_route(hub_url, &route),
        "POST",
        Some(token),
        Some(body),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_declares_launch_settings_and_an_optional_default_directory() {
        let key = space_key("space", "owner".into(), "machine".into(), "codex".into());
        let body = add_command(
            &key,
            "reviewer".into(),
            AgentLaunch {
                runtime: "codex".into(),
                args: vec!["--full-auto".into()],
                backend: "codex-app".into(),
            },
            Some("/repo".into()),
        );
        assert_eq!(body["action"], "create");
        assert_eq!(body["key"], key);
        assert_eq!(body["displayName"], "reviewer");
        assert_eq!(body["defaultWorkspace"], "/repo");
        assert_eq!(
            body["environment"]["launch"],
            serde_json::json!({"runtime":"codex","runtimeArgs":["--full-auto"],"backend":"codex-app"})
        );
        assert_eq!(body["environment"]["enabled"], true);
        let no_backend = add_command(
            &key,
            "x".into(),
            AgentLaunch {
                runtime: "x".into(),
                args: vec![],
                backend: " ".into(),
            },
            None,
        );
        assert!(no_backend["environment"]["launch"].get("backend").is_none());
        assert!(no_backend.get("defaultWorkspace").is_none());
    }

    #[test]
    fn remove_revokes_the_current_grant_only_when_allowed() {
        let key = space_key("space", "owner".into(), "machine".into(), "codex".into());
        let limits =
            serde_json::json!({"workspaces":["w"],"models":[],"secrets":[],"capabilities":[]});
        let current = serde_json::json!({"canRemoveFromSpace": true,
            "access": {"grant": {"state":"active","revision":3,"limits":limits}}});
        let body = remove_command(&key, &current).expect("removable");
        assert_eq!(body["action"], "owner-grant");
        assert_eq!(body["state"], "revoked");
        assert_eq!(body["expectedRevision"], 3);
        assert_eq!(body["limits"], limits);
        assert!(remove_command(&key, &serde_json::json!({"canRemoveFromSpace": false})).is_err());
        assert!(remove_command(&key, &serde_json::json!({"canRemoveFromSpace": true})).is_err());
    }

    #[test]
    fn a_space_admin_disables_against_the_space_revision() {
        let key = space_key("space", "owner".into(), "machine".into(), "codex".into());
        let current =
            serde_json::json!({"canConfigureSpace": true, "access": {"policy": {"revision": 7}}});
        let body = space_state_command(&key, &current, false).expect("admin");
        assert_eq!(body["action"], "space-state");
        assert_eq!(body["state"], "disabled");
        assert_eq!(body["expectedRevision"], 7);
        assert_eq!(
            space_state_command(&key, &current, true).expect("admin")["state"],
            "enabled"
        );
        assert!(
            space_state_command(
                &key,
                &serde_json::json!({"canConfigureSpace": false}),
                false
            )
            .is_err()
        );
    }

    #[test]
    fn an_owner_disabled_registration_lists_as_disabled() {
        let row =
            serde_json::json!({"state":"enabled","routingBlocker":"owner_environment_disabled"});
        assert_eq!(state_label(&row), "disabled");
        assert_eq!(
            state_label(&serde_json::json!({"state":"disabled"})),
            "disabled"
        );
        assert_eq!(
            state_label(&serde_json::json!({"state":"revoked"})),
            "revoked"
        );
    }

    #[test]
    fn only_concrete_harnesses_are_added() {
        assert!(concrete_preset("codex").is_ok());
        assert!(concrete_preset("custom").is_err());
        assert!(concrete_preset("no-such-harness").is_err());
    }
}
