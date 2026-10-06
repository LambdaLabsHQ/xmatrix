use serde::Deserialize;
use serde_json::{Value, json};
use xmatrix_cli_args::AutomationCommand;

use crate::{CliError, HubRoutes, error, http, protocol, with_route};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationCatalog {
    #[serde(default)]
    automations: Vec<Value>,
    #[serde(default)]
    agent_management_enabled: bool,
}

fn require_agent_management(catalog: &AutomationCatalog) -> error::Result<()> {
    if catalog.agent_management_enabled {
        Ok(())
    } else {
        Err(CliError::UpgradeRequired(
            "This Hub does not advertise Agent Automation management. Upgrade the Hub before using `xmatrix automation`.".to_string(),
        ))
    }
}

fn automations_json(automations: &[Value]) -> error::Result<String> {
    Ok(serde_json::to_string_pretty(automations)?)
}

async fn catalog(
    hub_url: &str,
    token: &str,
    channel: Option<&str>,
    space: Option<&str>,
) -> error::Result<AutomationCatalog> {
    let mut route = HubRoutes::AUTOMATIONS.to_string();
    if let Some(channel) = channel {
        route.push_str("?channelId=");
        route.push_str(&urlencoding::encode(channel));
    } else if let Some(space) = space {
        route.push_str("?spaceId=");
        route.push_str(&urlencoding::encode(space));
    }
    let result: AutomationCatalog =
        http::request_json(&with_route(hub_url, &route), "GET", Some(token), None).await?;
    require_agent_management(&result)?;
    Ok(result)
}

async fn mutate(
    hub_url: &str,
    token: &str,
    route: &str,
    method: &str,
    body: Value,
) -> error::Result<()> {
    // Fail closed against an older Hub before sending any mutation.
    let _ = catalog(hub_url, token, None, None).await?;
    let result: Value =
        http::request_json(&with_route(hub_url, route), method, Some(token), Some(body)).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

async fn mutate_versioned(
    hub_url: &str,
    token: &str,
    route: &str,
    method: &str,
    expected_version: u64,
    reason: Option<String>,
) -> error::Result<()> {
    let mut body = json!({ "expectedVersion": expected_version });
    if let Some(reason) = reason {
        body["reason"] = Value::String(reason);
    }
    mutate(hub_url, token, route, method, body).await
}

pub(crate) async fn cmd_automation(
    hub_url: &str,
    token: &str,
    command: AutomationCommand,
) -> error::Result<()> {
    match command {
        AutomationCommand::List {
            channel,
            space,
            json: json_output,
        } => {
            if channel.is_none() && space.is_none() {
                return Err(CliError::Http(
                    "automation list requires --channel or --space".to_string(),
                ));
            }
            let result = catalog(hub_url, token, channel.as_deref(), space.as_deref()).await?;
            if json_output {
                println!("{}", automations_json(&result.automations)?);
            } else {
                for automation in result.automations {
                    println!(
                        "{}\tv{}\t{}\t{}",
                        automation["id"].as_str().unwrap_or("unknown"),
                        automation["version"].as_u64().unwrap_or_default(),
                        if automation["enabled"].as_bool() == Some(true) {
                            "active"
                        } else {
                            "paused"
                        },
                        automation["name"].as_str().unwrap_or("unnamed")
                    );
                }
            }
            Ok(())
        }
        AutomationCommand::Update {
            automation_id,
            expected_version,
            name,
            expression,
            interval_minutes,
            reason,
            json: _,
        } => {
            let mut body = json!({ "expectedVersion": expected_version });
            if let Some(name) = name {
                body["name"] = Value::String(name);
            }
            if let Some(expression) = expression {
                body["expression"] = json!({
                    "kind": "text",
                    "language": "natural-language",
                    "text": expression,
                });
            }
            if let Some(minutes) = interval_minutes {
                body["intervalMinutes"] = json!(minutes);
            }
            if let Some(reason) = reason {
                body["reason"] = Value::String(reason);
            }
            mutate(
                hub_url,
                token,
                &protocol::automation_route(&automation_id),
                "PATCH",
                body,
            )
            .await
        }
        AutomationCommand::Pause {
            automation_id,
            expected_version,
            reason,
            json: _,
        } => {
            mutate_versioned(
                hub_url,
                token,
                &protocol::automation_pause_route(&automation_id),
                "POST",
                expected_version,
                reason,
            )
            .await
        }
        AutomationCommand::Resume {
            automation_id,
            expected_version,
            reason,
            json: _,
        } => {
            mutate_versioned(
                hub_url,
                token,
                &protocol::automation_resume_route(&automation_id),
                "POST",
                expected_version,
                reason,
            )
            .await
        }
        AutomationCommand::CancelExecution {
            automation_id,
            run_id,
            json: _,
        } => {
            mutate(
                hub_url,
                token,
                &protocol::automation_cancel_execution_route(&automation_id),
                "POST",
                json!({ "runId": run_id }),
            )
            .await
        }
        AutomationCommand::Delete {
            automation_id,
            expected_version,
            reason,
            json: _,
        } => {
            mutate_versioned(
                hub_url,
                token,
                &protocol::automation_route(&automation_id),
                "DELETE",
                expected_version,
                reason,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::automations_json;

    #[test]
    fn automation_json_preserves_the_concrete_latest_execution_failure() {
        let error = "Focus organization needs an enabled xMatrix Management Agent";
        let rendered = automations_json(&[serde_json::json!({
            "id": "task-focus",
            "latestExecution": {
                "status": "pending",
                "errorCode": "dispatch_retry",
                "errorMessage": error,
            },
        })])
        .expect("Automation JSON should render");
        let output: serde_json::Value =
            serde_json::from_str(&rendered).expect("Automation output should remain JSON");
        assert_eq!(output[0]["latestExecution"]["errorMessage"], error);
    }
}
