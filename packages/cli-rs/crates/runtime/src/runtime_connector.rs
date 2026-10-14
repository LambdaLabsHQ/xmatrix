//! `xmatrix connector list`: the connected apps of this Agent Run's Channel
//! and each action's command (docs/design/connector-platform.md §3.5). An
//! Agent acts in one by sending that command as an ordinary Channel message,
//! where it is parsed like anyone's and its receipt replies to it.

use serde_json::Value;
use xmatrix_cli_core::error::Result;
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::{HubRoutes, with_route};

fn render(listing: &Value) -> String {
    let connectors = listing["connectors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if connectors.is_empty() {
        return "No app is connected to this Channel's Space.\n".to_string();
    }
    let mut out = String::new();
    for connector in &connectors {
        out.push_str(&format!(
            "{} ({})\n",
            connector["name"].as_str().unwrap_or_default(),
            connector["provider"].as_str().unwrap_or_default()
        ));
        for action in connector["actions"].as_array().into_iter().flatten() {
            out.push_str(&format!(
                "  {:<5}  {}\n         {}\n",
                action["effect"].as_str().unwrap_or_default(),
                action["command"].as_str().unwrap_or_default(),
                action["description"].as_str().unwrap_or_default()
            ));
        }
    }
    out.push_str(
        "\nSend one with `xmatrix send <channel-id> \"<command>\"`; its result replies to your message.\n",
    );
    out
}

pub(crate) async fn cmd_connector_list(hub_url: &str, token: &str) -> Result<()> {
    let listing: Value = http::request_json(
        &with_route(hub_url, HubRoutes::CONNECTOR_USAGE),
        "GET",
        Some(token),
        None,
    )
    .await?;
    print!("{}", render(&listing));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_each_connected_app_with_its_commands() {
        let text = render(&json!({ "connectors": [{
            "provider": "gmail", "name": "Gmail",
            "actions": [{ "command": "@gmail:search:* <Gmail query>", "effect": "read",
                "description": "Search mail." }]
        }] }));
        assert!(text.starts_with(
            "Gmail (gmail)\n  read   @gmail:search:* <Gmail query>\n         Search mail.\n"
        ));
        assert!(text.contains("xmatrix send <channel-id>"));
    }

    #[test]
    fn says_when_nothing_is_connected() {
        assert_eq!(
            render(&json!({ "connectors": [] })),
            "No app is connected to this Channel's Space.\n"
        );
    }
}
