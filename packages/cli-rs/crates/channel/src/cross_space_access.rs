//! Cross-Space read grants (docs/cross-space-read-grants.md): an Agent Run asks
//! its owner to read a Channel or Space outside its own Space, and the owner
//! approves, denies, or revokes that read-only grant.

use std::time::{Duration, Instant};

use colored::Colorize;
use serde::Deserialize;
use serde_json::json;
use xmatrix_cli_args::AccessCommand;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::{
    HubRoutes, cross_space_read_grant_decision_route, cross_space_read_grant_route, with_route,
};

const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    #[serde(rename = "ref")]
    reference: String,
    channel_id: String,
    scope: String,
    status: String,
    expires_at: String,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    read_count: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantEnvelope {
    grant: Grant,
    #[serde(default)]
    notice_error: Option<String>,
}

/// `<space-id>/<grant-id>`, as `xmatrix access request` and the card print it.
fn grant_reference(reference: &str) -> error::Result<(&str, &str)> {
    match reference.trim().split_once('/') {
        Some((space_id, grant_id)) if !space_id.is_empty() && !grant_id.is_empty() => {
            Ok((space_id, grant_id))
        }
        _ => Err(CliError::Launch(format!(
            "grant reference must be <space-id>/<grant-id>, got '{reference}'"
        ))),
    }
}

fn coverage(grant: &Grant) -> String {
    if grant.scope == "space" {
        format!("the whole Space of Channel {}", grant.channel_id)
    } else {
        format!("Channel {} and its threads", grant.channel_id)
    }
}

fn print_grant(grant: &Grant) {
    println!("Grant:    {}", grant.reference);
    println!("Covers:   {}", coverage(grant));
    if let Some(agent) = &grant.agent_name {
        println!("Agent:    {agent}");
    }
    if let Some(reason) = &grant.reason {
        println!("Reason:   {reason}");
    }
    println!("Status:   {}", grant.status);
    if grant.status == "approved" {
        println!("Expires:  {} (UTC)", grant.expires_at);
        println!("Reads:    {}", grant.read_count);
    }
}

async fn read_grant(hub_url: &str, token: &str, reference: &str) -> error::Result<Grant> {
    let (space_id, grant_id) = grant_reference(reference)?;
    let url = with_route(hub_url, &cross_space_read_grant_route(space_id, grant_id));
    let envelope: GrantEnvelope = http::request_json(&url, "GET", Some(token), None).await?;
    Ok(envelope.grant)
}

async fn decide(
    hub_url: &str,
    token: &str,
    reference: &str,
    body: serde_json::Value,
) -> error::Result<Grant> {
    let (space_id, grant_id) = grant_reference(reference)?;
    let url = with_route(
        hub_url,
        &cross_space_read_grant_decision_route(space_id, grant_id),
    );
    let envelope: GrantEnvelope = http::request_json(&url, "POST", Some(token), Some(body)).await?;
    Ok(envelope.grant)
}

pub async fn cmd_access(hub_url: &str, token: &str, command: AccessCommand) -> error::Result<()> {
    match command {
        AccessCommand::Request {
            channel_id,
            whole_space,
            reason,
            no_wait,
            timeout,
        } => {
            let channel_id = super::resolve_channel_reference(hub_url, token, &channel_id).await?;
            let envelope: GrantEnvelope = http::request_json(
                &with_route(hub_url, HubRoutes::CROSS_SPACE_READ_REQUESTS),
                "POST",
                Some(token),
                Some(json!({
                    "channelId": channel_id,
                    "scope": if whole_space { "space" } else { "channel" },
                    "reason": reason,
                })),
            )
            .await?;
            let mut grant = envelope.grant;
            if let Some(error) = envelope.notice_error {
                eprintln!(
                    "{} The approval card could not be posted ({error}). The owner can run: xmatrix access approve {}",
                    "!".yellow().bold(),
                    grant.reference
                );
            }
            if grant.status == "pending" && !no_wait {
                println!(
                    "Waiting for the owner to decide {} (up to {timeout}s)...",
                    grant.reference
                );
                let deadline = Instant::now() + Duration::from_secs(timeout);
                while grant.status == "pending" && Instant::now() < deadline {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    grant = read_grant(hub_url, token, &grant.reference).await?;
                }
            }
            print_grant(&grant);
            match grant.status.as_str() {
                "approved" => println!(
                    "{} Read it as usual, for example: xmatrix channel history {}",
                    "✓".green().bold(),
                    grant.channel_id
                ),
                "pending" => println!(
                    "Still pending. Check later with: xmatrix access status {}",
                    grant.reference
                ),
                _ => {}
            }
            Ok(())
        }
        AccessCommand::Status { grant } => {
            print_grant(&read_grant(hub_url, token, &grant).await?);
            Ok(())
        }
        AccessCommand::Approve {
            grant,
            channel_only,
        } => {
            let body = if channel_only {
                json!({ "action": "approve", "scope": "channel" })
            } else {
                json!({ "action": "approve" })
            };
            let grant = decide(hub_url, token, &grant, body).await?;
            println!("{} Approved", "✓".green().bold());
            print_grant(&grant);
            Ok(())
        }
        AccessCommand::Deny { grant } => {
            let grant = decide(hub_url, token, &grant, json!({ "action": "deny" })).await?;
            println!("{} Denied", "✓".green().bold());
            print_grant(&grant);
            Ok(())
        }
        AccessCommand::Revoke { grant } => {
            let grant = decide(hub_url, token, &grant, json!({ "action": "revoke" })).await?;
            println!("{} Revoked", "✓".green().bold());
            print_grant(&grant);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::grant_reference;

    #[test]
    fn grant_reference_names_the_space_that_holds_the_grant() {
        assert_eq!(
            grant_reference(" space-1/csr_abc ").expect("reference"),
            ("space-1", "csr_abc")
        );
        for invalid in ["csr_abc", "/csr_abc", "space-1/", ""] {
            assert!(grant_reference(invalid).is_err(), "{invalid}");
        }
    }
}
