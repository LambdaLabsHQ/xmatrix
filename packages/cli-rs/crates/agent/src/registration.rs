use super::*;
use std::io::{IsTerminal, Write};
use xmatrix_cli_core::protocol;

/// A field of the registration of the Run this CLI runs inside.
fn run_registration_field(field: &str) -> Option<String> {
    let registration: Value =
        serde_json::from_str(&std::env::var("XMATRIX_AGENT_REGISTRATION").ok()?).ok()?;
    registration[field]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The owner of the Run this CLI runs inside, from its registration.
fn run_owner_user_id() -> Option<String> {
    run_registration_field("ownerUserId")
}

/// The named Space, or the Space of the Run this CLI runs inside.
fn space_or_run(space: Option<String>) -> error::Result<String> {
    space
        .or_else(|| run_registration_field("spaceId"))
        .ok_or_else(|| {
            CliError::Launch("Name the Space with --space <id> (see `xmatrix spaces`)".into())
        })
}

/// A Space's Agents are its registrations: one harness on one owner's machine.
/// Inside a Run, an Agent lists its Space's Agents, adds one for its owner on
/// its own machine and sets the model of its owner's Agents, as the owner
/// would; the rest stays with people.
pub(super) async fn run(hub_url: &str, token: &str, command: AgentCommand) -> error::Result<()> {
    let run_owner = if access::inside_agent_run() {
        if !matches!(
            command,
            AgentCommand::List { .. }
                | AgentCommand::Add { .. }
                | AgentCommand::Describe { .. }
                | AgentCommand::Model { .. }
        ) {
            return Err(CliError::Launch(
                "Inside an Agent Run, `xmatrix agent` lists, adds and describes Agents and sets their model; the owner changes or removes them".into(),
            ));
        }
        Some(run_owner_user_id().ok_or_else(|| {
            CliError::Launch("This Run has no registration to add an Agent for".into())
        })?)
    } else {
        None
    };
    match command {
        AgentCommand::List {
            space,
            machine,
            json,
        } => {
            list(
                hub_url,
                token,
                &space_or_run(space)?,
                machine.as_deref(),
                json,
            )
            .await
        }
        AgentCommand::Add {
            harness,
            space,
            name,
            runtime,
            args,
            workspace,
            access,
        } => {
            let in_run = run_owner.is_some();
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
            if let Some(reason) = crate::refused_agent_harness_reason(&runtime) {
                return Err(CliError::Launch(reason.into()));
            }
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
            // What the Agent may do on this machine is its owner's to confirm,
            // once per harness here. Inside a Run the Hub decides: a Run never
            // confirms for its owner.
            let access = if in_run {
                None
            } else {
                confirm_access(hub_url, token, &key, preset, access).await?
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
                    access,
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
        AgentCommand::Access { harness, mode } => {
            machine_access(hub_url, token, harness, mode).await
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
            // What a launch of it adds on its machine, as the Hub resolves it.
            let catalog: Value = http::request_json(
                &with_route(hub_url, &protocol::space_agent_registrations_route(&space)),
                "GET",
                Some(token),
                None,
            )
            .await?;
            if let Some(listed) = catalog["registrations"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|listed| listed["key"] == key)
                && !listed["access"].is_null()
            {
                value["launchAccess"] = listed["access"].clone();
            }
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
        AgentCommand::Describe {
            harness,
            text,
            space,
            stdin,
        } => {
            let text = if stdin {
                let mut input = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
                Some(input)
            } else {
                text
            };
            describe(hub_url, token, &space_or_run(space)?, &harness, text).await
        }
        AgentCommand::Model {
            harness,
            model,
            clear,
            space,
            owner,
            machine,
        } => {
            let space = space_or_run(space)?;
            let key = resolve_key(hub_url, &space, owner.or(run_owner), machine, harness).await?;
            set_model(hub_url, token, &space, &key, model, clear).await
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

async fn list(
    hub_url: &str,
    token: &str,
    space: &str,
    machine: Option<&str>,
    json: bool,
) -> error::Result<()> {
    // Like the Agents page, the list asks the Space's daemons to read quota
    // again (each at most once a minute); the next list shows that reading.
    let value: Value = http::request_json(
        &format!(
            "{}?quota=refresh",
            with_route(hub_url, &protocol::space_agent_registrations_route(space))
        ),
        "GET",
        Some(token),
        None,
    )
    .await?;
    let mut registrations = value["registrations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(machine) = machine {
        registrations.retain(|registration| on_machine(registration, machine));
    }
    // One Machine's Agents together, so what it can run reads off one block.
    registrations.sort_by_key(|registration| {
        (
            registration["machineName"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase(),
            registration["key"]["machineId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            registration["key"]["harness"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        )
    });
    if json {
        println!("{}", serde_json::json!({ "registrations": registrations }));
        return Ok(());
    }
    if registrations.is_empty() {
        match machine {
            Some(machine) => println!("No Agents on Machine {machine} in Space {space}."),
            None => println!(
                "No Agents in Space {space}. Add one with `xmatrix agent add <harness> --space {space}`."
            ),
        }
        return Ok(());
    }
    let text = |value: &Value| value.as_str().unwrap_or("-").to_string();
    let width = registrations
        .iter()
        .map(|registration| text(&registration["machineName"]).chars().count())
        .chain([7])
        .max()
        .unwrap_or(7);
    println!(
        "{:<width$} {:<8} {:<10} {:<16} {:<22} {:<6} {:<6} {}",
        "MACHINE".bold(),
        "ONLINE".bold(),
        "HARNESS".bold(),
        "NAME".bold(),
        "STATE".bold(),
        "QUOTA".bold(),
        "ACCESS".bold(),
        "OWNER".bold()
    );
    for registration in &registrations {
        println!(
            "{:<width$} {:<8} {:<10} {:<16} {:<22} {:<6} {:<6} {}",
            text(&registration["machineName"]),
            online_label(registration),
            text(&registration["key"]["harness"]),
            text(&registration["displayName"]),
            state_label(registration),
            quota_label(registration),
            // What its launches may do on its Machine; `agent show` lists what that adds.
            text(&registration["access"]["mode"]),
            text(&registration["ownerName"])
        );
    }
    Ok(())
}

/// A Machine named by its name (any case) or its id.
fn on_machine(registration: &Value, machine: &str) -> bool {
    registration["key"]["machineId"].as_str() == Some(machine)
        || registration["machineName"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(machine))
}

/// Whether the owner's daemon on its Machine is connected; `-` from a Hub that does not say.
fn online_label(registration: &Value) -> &'static str {
    match registration["live"]["machine"]["online"].as_bool() {
        Some(true) => "online",
        Some(false) => "offline",
        None => "-",
    }
}

/// The provider quota left while the reading is current: the share of its
/// tightest window, or the money on a prepaid account, which has no window.
fn quota_label(registration: &Value) -> String {
    let balance = &registration["live"]["balance"];
    if let (Some(balance), Some(currency)) =
        (balance["amount"].as_f64(), balance["currency"].as_str())
    {
        return match currency {
            "CNY" => format!("¥{balance:.2}"),
            "USD" => format!("${balance:.2}"),
            _ => format!("{balance:.2} {currency}"),
        };
    }
    registration["live"]["quota"]["remainingPercent"]
        .as_f64()
        .map(|percent| format!("{}%", percent.round()))
        .unwrap_or_else(|| "-".to_string())
}

/// Prints what the Space says a harness is for, or rewrites it with `text`.
async fn describe(
    hub_url: &str,
    token: &str,
    space: &str,
    harness: &str,
    text: Option<String>,
) -> error::Result<()> {
    let Some(text) = text else {
        let value: Value = http::request_json(
            &with_route(hub_url, &protocol::space_agent_registrations_route(space)),
            "GET",
            Some(token),
            None,
        )
        .await?;
        let profile = harness_profile(&value, harness)
            .ok_or_else(|| CliError::Launch(format!("No {harness} Agent in Space {space}")))?;
        match profile["description"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            Some(description) => println!("{description}"),
            None => println!(
                "No description yet. Write one with `xmatrix agent describe {harness} \"<text>\" --space {space}`."
            ),
        }
        return Ok(());
    };
    let saved: Value = http::request_json(
        &with_route(
            hub_url,
            &protocol::space_harness_profile_command_route(space),
        ),
        "POST",
        Some(token),
        Some(serde_json::json!({"harness": harness, "description": text})),
    )
    .await?;
    let cleared = saved["description"].as_str().is_none_or(str::is_empty);
    println!(
        "{} {} {} in Space {}",
        "✓".green(),
        if cleared {
            "Cleared the description of"
        } else {
            "Described"
        },
        saved["harness"].as_str().unwrap_or(harness).bold(),
        space
    );
    Ok(())
}

/// The harness's profile, which every one of its registrations in the catalog carries.
fn harness_profile<'a>(catalog: &'a Value, harness: &str) -> Option<&'a Value> {
    catalog["registrations"]
        .as_array()?
        .iter()
        .find(|registration| {
            registration["key"]["harness"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(harness))
        })
        .map(|registration| &registration["profile"])
}

/// Disabled in the Space, or (before disabling was per Space) on its machine.
/// Its Space state; an enabled Agent that cannot take work yet says why.
fn state_label(registration: &Value) -> String {
    let blocker = registration["routingBlocker"].as_str();
    if blocker == Some("owner_environment_disabled") {
        return "disabled".to_string();
    }
    let state = registration["state"].as_str().unwrap_or("-");
    match blocker {
        Some(blocker) if state == "enabled" => blocker.replace('_', " "),
        // Enabled, but its owner keeps the Machine out of automatic assignment:
        // a summon runs here only when it names the Machine.
        _ if state == "enabled"
            && registration["live"]["machine"]["autoAssign"].as_bool() == Some(false) =>
        {
            "enabled, named only".to_string()
        }
        _ => state.to_string(),
    }
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

/// Shows the model an Agent runs when a launch names none, or sets it. A model
/// runs only where its owner's grant allows it, so setting one the grant does
/// not list adds it there first: only the owner (or a Run of theirs) can.
async fn set_model(
    hub_url: &str,
    token: &str,
    space: &str,
    key: &Value,
    model: Option<String>,
    clear: bool,
) -> error::Result<()> {
    let current = details(hub_url, token, space, key).await?;
    let name = current["displayName"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let model = model.map(|model| model.trim().to_string());
    if model.is_none() && !clear {
        match current["configuration"]["model"].as_str() {
            Some(model) => println!("{model}"),
            None => println!(
                "{name} runs its harness's default model. Set one with `xmatrix agent model {} <model> --space {space}`.",
                key["harness"].as_str().unwrap_or_default()
            ),
        }
        return Ok(());
    }
    if let Some(model) = model.as_deref().filter(|model| !granted(&current, model)) {
        command_request(
            hub_url,
            token,
            space,
            grant_model_command(key, &current, model)?,
        )
        .await?;
    }
    command_request(
        hub_url,
        token,
        space,
        model_command(key, &current, model.as_deref())?,
    )
    .await?;
    match model {
        Some(model) => println!(
            "{} {} runs {} in Space {}",
            "✓".green(),
            name.bold(),
            model.bold(),
            space
        ),
        None => println!(
            "{} {} runs its harness's default model in Space {}",
            "✓".green(),
            name.bold(),
            space
        ),
    }
    Ok(())
}

/// Whether the owner's grant already lets the Agent run `model`.
fn granted(current: &Value, model: &str) -> bool {
    current["access"]["grant"]["limits"]["models"]
        .as_array()
        .is_some_and(|models| models.iter().any(|item| item.as_str() == Some(model)))
}

/// The owner's grant, as it stands, with `model` added to the models it allows.
fn grant_model_command(key: &Value, current: &Value, model: &str) -> error::Result<Value> {
    if current["canManageOwnerGrant"].as_bool() != Some(true) {
        return Err(CliError::Launch(format!(
            "The Agent's owner allows {model} first: only they, or a Run of theirs, can set a model their grant does not list"
        )));
    }
    let grant = &current["access"]["grant"];
    let revision = grant["revision"]
        .as_u64()
        .ok_or_else(|| CliError::Launch("The Agent's grant is unavailable".into()))?;
    if grant["state"].as_str() != Some("active") {
        return Err(CliError::Launch(
            "The Agent is removed from this Space; add it back before setting its model".into(),
        ));
    }
    let mut limits = grant["limits"].clone();
    match limits["models"].as_array_mut() {
        Some(models) => models.push(Value::String(model.to_string())),
        None => return Err(CliError::Launch("The Agent's grant is unavailable".into())),
    }
    Ok(serde_json::json!({
        "action": "owner-grant",
        "commandId": format!("registration-model-grant:{}", uuid::Uuid::new_v4()),
        "key": key,
        "state": "active",
        "expectedRevision": revision,
        "limits": limits,
    }))
}

/// The Space's configuration, as it stands, with only its model changed.
fn model_command(key: &Value, current: &Value, model: Option<&str>) -> error::Result<Value> {
    if current["canConfigureSpace"].as_bool() != Some(true) {
        return Err(CliError::Launch(
            "Only a Space owner or admin, or a Run of theirs, can set an Agent's model".into(),
        ));
    }
    let mut configuration = current["configuration"].clone();
    let fields = configuration
        .as_object_mut()
        .ok_or_else(|| CliError::Launch("The Agent's configuration is unavailable".into()))?;
    match model {
        Some(model) => fields.insert("model".into(), Value::String(model.to_string())),
        None => fields.remove("model"),
    };
    Ok(serde_json::json!({
        "action": "configure",
        "commandId": format!("registration-model:{}", uuid::Uuid::new_v4()),
        "key": key,
        "displayName": current["displayName"],
        "expectedVersion": current["version"],
        "configuration": configuration,
    }))
}

fn concrete_preset(harness: &str) -> error::Result<&'static AgentPreset> {
    if let Some(reason) = crate::refused_agent_harness_reason(harness) {
        return Err(CliError::Launch(reason.into()));
    }
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
    /// The access mode its owner confirmed with this add.
    access: Option<String>,
}

/// What full access adds to a harness's launch, word for word as the Hub
/// resolves it (`AgentAccessGrant`), then what that means on the machine.
fn access_disclosure(name: &str, grant: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    for arg in grant["args"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        lines.push(format!("  adds the argument               {arg}"));
    }
    for (key, value) in grant["env"].as_object().into_iter().flatten() {
        lines.push(format!(
            "  sets the environment variable    {key}={}",
            value.as_str().unwrap_or_default()
        ));
    }
    for (key, value) in grant["session"].as_object().into_iter().flatten() {
        lines.push(format!(
            "  starts each session with         {key}={}",
            value.as_str().unwrap_or_default()
        ));
    }
    if lines.is_empty() {
        lines.push("  adds no argument or environment variable to its launch".into());
    }
    if grant["approvesRequests"].as_bool() == Some(true) {
        lines.push(format!(
            "  answers every permission request {name} makes with allow"
        ));
    }
    lines.insert(
        0,
        format!("With full access, xMatrix starts {name} like this:"),
    );
    lines.push(format!(
        "{name} then works without asking before it changes a file or runs a command, and xMatrix sets no limit on which files it reaches."
    ));
    lines
}

/// The access mode this add confirms, or none when the owner already
/// confirmed one for this harness on this machine. The disclosure is printed
/// before anything is written; without `--access` a person at a terminal is
/// asked, and anything else is refused with what to show the owner.
async fn confirm_access(
    hub_url: &str,
    token: &str,
    key: &Value,
    preset: &AgentPreset,
    access: Option<String>,
) -> error::Result<Option<String>> {
    let held = held_environment(hub_url, token, key).await?;
    if let Some(mode) = held["environment"]["launch"]["access"].as_str() {
        println!(
            "Access on this machine: {mode}, as its owner confirmed for {} earlier",
            preset.display_name
        );
        return Ok(None);
    }
    for line in access_disclosure(&preset.display_name, &held["fullAccess"]) {
        eprintln!("{line}");
    }
    let asks = offers_ask(&held);
    if asks {
        eprintln!("{}", ask_disclosure(&preset.display_name));
    }
    if access.is_some() {
        return Ok(access);
    }
    if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
        return Err(CliError::Launch(
            "Nothing was added. This machine's owner confirms the access above first: show it to them, and once they agree run the same command with --access full".into(),
        ));
    }
    if asks {
        eprint!(
            "Access for {} on this machine? [full/ask/none] ",
            preset.display_name
        );
    } else {
        eprint!(
            "Add {} with full access on this machine? [y/N] ",
            preset.display_name
        );
    }
    std::io::stderr().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    match answer.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" | "full" => Ok(Some("full".into())),
        "ask" if asks => Ok(Some("ask".into())),
        _ => Err(CliError::Launch("Nothing was added".into())),
    }
}

/// The machine owner's environment for a harness, with what full access adds
/// to its launch and the modes it can be given, as the Hub resolves them.
async fn held_environment(hub_url: &str, token: &str, key: &Value) -> error::Result<Value> {
    http::request_json(
        &with_route(hub_url, protocol::AGENT_ENVIRONMENT_QUERY_ROUTE),
        "POST",
        Some(token),
        Some(
            serde_json::json!({ "ownerUserId": key["ownerUserId"], "machineId": key["machineId"],
            "harness": key["harness"] }),
        ),
    )
    .await
}

fn offers_ask(held: &Value) -> bool {
    held["accessModes"]
        .as_array()
        .is_some_and(|modes| modes.iter().any(|mode| mode == "ask"))
}

fn ask_disclosure(name: &str) -> String {
    format!(
        "With ask access (--access ask), xMatrix adds none of that: {name} runs on its own defaults, and each time it wants permission for a file or a command it asks in the Channel it is working in and waits. Plain xmatrix commands are not asked about."
    )
}

/// Show what a harness's Agents may do on this machine, or change it. The
/// change is the owner's environment command against the version just read.
async fn machine_access(
    hub_url: &str,
    token: &str,
    harness: String,
    mode: Option<String>,
) -> error::Result<()> {
    let owner_user_id = config::load_session_for_hub(hub_url)
        .await
        .ok_or_else(|| CliError::Auth("Log in as the machine owner first".into()))?
        .user
        .id;
    let preset = concrete_preset(&harness)?;
    let key = serde_json::json!({ "ownerUserId": owner_user_id,
        "machineId": config::get_or_create_machine_id(hub_url).await?, "harness": preset.id });
    let held = held_environment(hub_url, token, &key).await?;
    let launch = &held["environment"]["launch"];
    if !launch.is_object() {
        return Err(CliError::Launch(format!(
            "{} is not added on this machine yet: `xmatrix agent add {} --space <id>`",
            preset.display_name, preset.id
        )));
    }
    let Some(mode) = mode else {
        match launch["access"].as_str() {
            Some(current) => println!("{} on this machine: {current} access", preset.display_name),
            None => println!(
                "{} on this machine: full access, which its owner has not confirmed yet",
                preset.display_name
            ),
        }
        for line in access_disclosure(&preset.display_name, &held["fullAccess"]) {
            println!("{line}");
        }
        if offers_ask(&held) {
            println!("{}", ask_disclosure(&preset.display_name));
        }
        return Ok(());
    };
    let mut environment = held["environment"].clone();
    environment["launch"]["access"] = Value::String(mode.clone());
    let _: Value = http::request_json(
        &with_route(hub_url, protocol::AGENT_ENVIRONMENT_COMMAND_ROUTE),
        "POST",
        Some(token),
        Some(serde_json::json!({ "key": key, "commandId": format!("registration-access:{}", uuid::Uuid::new_v4()),
            "expectedVersion": held["version"], "environment": environment })),
    )
    .await?;
    println!(
        "{} {} on this machine now has {mode} access; it applies to its next Runs",
        "✓".green(),
        preset.display_name
    );
    Ok(())
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
    if let Some(access) = launch.access {
        launch_json["access"] = Value::String(access);
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

    fn registration_details() -> Value {
        serde_json::json!({
            "displayName": "antigravity", "version": 4,
            "canManageOwnerGrant": true, "canConfigureSpace": true,
            "configuration": {"workingMode": "autonomous", "instructions": "Keep it short.",
                "workspaceReferences": ["ws-1"], "model": "gemini-4-argon-medium"},
            "access": {"grant": {"state": "active", "revision": 7,
                "limits": {"workspaces": ["ws-1"], "models": [], "capabilities": []}}},
        })
    }

    #[test]
    fn setting_a_model_changes_only_the_model_and_keeps_the_rest_of_the_configuration() {
        let key = space_key(
            "space",
            "owner".into(),
            "machine".into(),
            "antigravity".into(),
        );
        let current = registration_details();
        let set = model_command(&key, &current, Some("gemini-4-hydrogen-medium")).unwrap();
        assert_eq!(set["action"], "configure");
        assert_eq!(set["expectedVersion"], 4);
        assert_eq!(set["displayName"], "antigravity");
        let mut expected = current["configuration"].clone();
        expected["model"] = "gemini-4-hydrogen-medium".into();
        assert_eq!(set["configuration"], expected);
        let cleared = model_command(&key, &current, None).unwrap();
        assert!(cleared["configuration"].get("model").is_none());
        assert_eq!(cleared["configuration"]["instructions"], "Keep it short.");
    }

    #[test]
    fn a_model_the_grant_does_not_list_is_added_to_it_by_its_owner_only() {
        let key = space_key(
            "space",
            "owner".into(),
            "machine".into(),
            "antigravity".into(),
        );
        let mut current = registration_details();
        assert!(!granted(&current, "gemini-4-hydrogen-medium"));
        let grant = grant_model_command(&key, &current, "gemini-4-hydrogen-medium").unwrap();
        assert_eq!(grant["action"], "owner-grant");
        assert_eq!(grant["state"], "active");
        assert_eq!(grant["expectedRevision"], 7);
        assert_eq!(
            grant["limits"],
            serde_json::json!({"workspaces": ["ws-1"], "models": ["gemini-4-hydrogen-medium"], "capabilities": []})
        );
        current["access"]["grant"]["limits"]["models"] =
            serde_json::json!(["gemini-4-hydrogen-medium"]);
        assert!(granted(&current, "gemini-4-hydrogen-medium"));
        current["canManageOwnerGrant"] = false.into();
        assert!(grant_model_command(&key, &current, "other").is_err());
        current["canManageOwnerGrant"] = true.into();
        current["access"]["grant"]["state"] = "revoked".into();
        assert!(grant_model_command(&key, &current, "other").is_err());
        current["canConfigureSpace"] = false.into();
        assert!(model_command(&key, &current, Some("other")).is_err());
    }

    #[test]
    fn a_harness_profile_is_read_from_any_of_its_registrations() {
        let catalog = serde_json::json!({"registrations": [
            {"key": {"harness": "claude"}, "profile": {"description": "", "revision": 0}},
            {"key": {"harness": "codex"}, "profile": {"description": "Audits code.", "revision": 2}},
        ]});
        assert_eq!(
            harness_profile(&catalog, "Codex").unwrap()["description"],
            "Audits code."
        );
        assert!(harness_profile(&catalog, "gemini").is_none());
    }

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
                access: Some("full".into()),
            },
            Some("/repo".into()),
        );
        assert_eq!(body["action"], "create");
        assert_eq!(body["key"], key);
        assert_eq!(body["displayName"], "reviewer");
        assert_eq!(body["defaultWorkspace"], "/repo");
        assert_eq!(
            body["environment"]["launch"],
            serde_json::json!({"runtime":"codex","runtimeArgs":["--full-auto"],"backend":"codex-app","access":"full"})
        );
        assert_eq!(body["environment"]["enabled"], true);
        let no_backend = add_command(
            &key,
            "x".into(),
            AgentLaunch {
                runtime: "x".into(),
                args: vec![],
                backend: " ".into(),
                access: None,
            },
            None,
        );
        assert!(no_backend["environment"]["launch"].get("backend").is_none());
        // Without a confirmation the add writes no mode: a Run never confirms
        // for its owner, and a harness confirmed earlier keeps its mode.
        assert!(no_backend["environment"]["launch"].get("access").is_none());
        assert!(no_backend.get("defaultWorkspace").is_none());
    }

    #[test]
    fn the_access_disclosure_names_everything_the_grant_adds() {
        let lines = access_disclosure(
            "DeepSeek Harness",
            &serde_json::json!({"mode":"full","args":["--flag"],"env":{"DSH_PERMISSION_MODE":"danger-full-access"},
                "session":{"sandbox":"danger-full-access"},"approvesRequests":true}),
        )
        .join("\n");
        for written in [
            "--flag",
            "DSH_PERMISSION_MODE=danger-full-access",
            "sandbox=danger-full-access",
            "answers every permission request DeepSeek Harness makes with allow",
        ] {
            assert!(lines.contains(written), "{written}");
        }
        // A harness xMatrix passes nothing to is said to get nothing, not left blank.
        let bare = access_disclosure(
            "OpenCode",
            &serde_json::json!({"mode":"full","args":[],"env":{},"session":{},"approvesRequests":true}),
        )
        .join("\n");
        assert!(bare.contains("adds no argument or environment variable"));
        assert!(bare.contains("answers every permission request OpenCode makes with allow"));
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
    fn an_agent_on_a_machine_kept_out_of_automatic_assignment_lists_as_named_only() {
        let row = serde_json::json!({"state":"enabled",
            "live":{"machine":{"online":true,"autoAssign":false}}});
        assert_eq!(state_label(&row), "enabled, named only");
        let automatic = serde_json::json!({"state":"enabled","live":{"machine":{"online":true}}});
        assert_eq!(state_label(&automatic), "enabled");
        let disabled = serde_json::json!({"state":"disabled",
            "live":{"machine":{"online":true,"autoAssign":false}}});
        assert_eq!(state_label(&disabled), "disabled");
    }

    #[test]
    fn a_listed_agent_says_whether_its_machine_can_take_work() {
        let row = serde_json::json!({"state":"enabled","routingBlocker":"model_unavailable",
            "machineName":"Laptop","key":{"machineId":"machine:abc","harness":"codex"},
            "live":{"machine":{"online":false},"quota":{"remainingPercent":12.4}}});
        assert_eq!(state_label(&row), "model unavailable");
        assert_eq!(online_label(&row), "offline");
        assert_eq!(quota_label(&row), "12%");
        assert!(on_machine(&row, "laptop") && on_machine(&row, "machine:abc"));
        assert!(!on_machine(&row, "Workstation"));
        // A prepaid account has no window: the money left is the reading.
        let prepaid = |currency: &str| serde_json::json!({"live":{"balance":{"amount":12.3,"currency":currency,"allowed":true}}});
        assert_eq!(quota_label(&prepaid("CNY")), "¥12.30");
        assert_eq!(quota_label(&prepaid("USD")), "$12.30");
        assert_eq!(quota_label(&prepaid("EUR")), "12.30 EUR");
        let credits = serde_json::json!({"live":{"quota":{"remainingPercent":1,
            "windows":[{"usedPercent":100}],"account":{"credits":{"balance":40}}}}});
        assert_eq!(quota_label(&credits), "1%");
        let unreported = serde_json::json!({"state":"enabled"});
        assert_eq!(
            (online_label(&unreported), quota_label(&unreported).as_str()),
            ("-", "-")
        );
    }

    #[test]
    fn only_concrete_harnesses_are_added() {
        assert!(concrete_preset("codex").is_ok());
        assert!(concrete_preset("custom").is_err());
        assert!(concrete_preset("no-such-harness").is_err());
    }
}
