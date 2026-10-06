//! The Space's connector actions as an MCP server for the harness an Agent
//! Run drives (docs/design/connector-platform.md §3.5). `xmatrix connector mcp`
//! speaks newline-delimited JSON-RPC on stdio and forwards each request to the
//! Hub's `/api/connectors/mcp` with the Run's own credential, resolved per
//! request so a refreshed Run token is always the one used.

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use xmatrix_cli_core::error::Result;
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::{HubRoutes, with_route};

/// The MCP server name harnesses list the tools under.
pub(crate) const CONNECTOR_MCP_SERVER_NAME: &str = "xmatrix-connectors";

/// Opt-out for a Run that must not see connector tools.
const CONNECTOR_MCP_DISABLED_ENV: &str = "XMATRIX_CONNECTOR_MCP";

/// The command a harness runs to reach the connector tools, when this process
/// is an Agent Run and the tools are not disabled.
pub(crate) fn connector_mcp_command() -> Option<(String, Vec<String>)> {
    if std::env::var(CONNECTOR_MCP_DISABLED_ENV).is_ok_and(|value| value.trim() == "0") {
        return None;
    }
    if std::env::var("XMATRIX_RUN_ID")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        return None;
    }
    let executable = std::env::current_exe().ok()?.to_string_lossy().into_owned();
    Some((executable, vec!["connector".to_string(), "mcp".to_string()]))
}

/// Claude Code's `--mcp-config` value for the connector tools.
pub(crate) fn claude_connector_mcp_config() -> Option<String> {
    connector_mcp_command().map(|(command, args)| claude_config_for(&command, &args))
}

fn claude_config_for(command: &str, args: &[String]) -> String {
    json!({ "mcpServers": { CONNECTOR_MCP_SERVER_NAME: { "command": command, "args": args } } })
        .to_string()
}

/// Codex `-c` config overrides registering the connector tools (TOML values).
pub(crate) fn codex_connector_mcp_overrides() -> Vec<String> {
    connector_mcp_command()
        .map(|(command, args)| codex_overrides_for(&command, &args))
        .unwrap_or_default()
}

fn codex_overrides_for(command: &str, args: &[String]) -> Vec<String> {
    let key = CONNECTOR_MCP_SERVER_NAME.replace('-', "_");
    let toml_string = |value: &str| Value::String(value.to_string()).to_string();
    let toml_args = format!(
        "[{}]",
        args.iter()
            .map(|arg| toml_string(arg))
            .collect::<Vec<_>>()
            .join(",")
    );
    vec![
        "-c".to_string(),
        format!("mcp_servers.{key}.command={}", toml_string(command)),
        "-c".to_string(),
        format!("mcp_servers.{key}.args={toml_args}"),
    ]
}

/// The ACP `mcpServers` list for a new or loaded session.
pub(crate) fn acp_connector_mcp_servers() -> Value {
    match connector_mcp_command() {
        Some((command, args)) => json!([{
            "name": CONNECTOR_MCP_SERVER_NAME,
            "command": command,
            "args": args,
            "env": [],
        }]),
        None => json!([]),
    }
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one stdio line: `None` for a notification (nothing is written back).
async fn answer(hub_url: &str, token: Result<String>, line: &str) -> Option<Value> {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Some(jsonrpc_error(Value::Null, -32700, "Parse error")),
    };
    let id = request.get("id").cloned()?;
    let token = match token {
        Ok(token) => token,
        Err(error) => {
            return Some(jsonrpc_error(
                id,
                -32001,
                &format!("xMatrix authentication failed: {error}"),
            ));
        }
    };
    match http::request_json::<Value>(
        &with_route(hub_url, HubRoutes::CONNECTORS_MCP),
        "POST",
        Some(&token),
        Some(request),
    )
    .await
    {
        Ok(response) => Some(response),
        Err(error) => Some(jsonrpc_error(
            id,
            -32002,
            &format!("xMatrix connector request failed: {error}"),
        )),
    }
}

pub(crate) async fn cmd_connector_mcp<F, Fut>(hub_url: &str, resolve_token: F) -> Result<()>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let is_request = serde_json::from_str::<Value>(line)
            .map(|value| value.get("id").is_some())
            .unwrap_or(true);
        let token = if is_request {
            resolve_token().await
        } else {
            Ok(String::new())
        };
        if let Some(response) = answer(hub_url, token, line).await {
            stdout.write_all(format!("{response}\n").as_bytes()).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_configs_name_the_connector_server_and_its_command() {
        let args = vec!["connector".to_string(), "mcp".to_string()];
        let claude: Value =
            serde_json::from_str(&claude_config_for("/opt/xm \"x\"", &args)).unwrap();
        assert_eq!(
            claude["mcpServers"]["xmatrix-connectors"]["command"],
            "/opt/xm \"x\""
        );
        assert_eq!(
            claude["mcpServers"]["xmatrix-connectors"]["args"],
            json!(["connector", "mcp"])
        );
        assert_eq!(
            codex_overrides_for("/opt/xm", &args),
            vec![
                "-c",
                "mcp_servers.xmatrix_connectors.command=\"/opt/xm\"",
                "-c",
                "mcp_servers.xmatrix_connectors.args=[\"connector\",\"mcp\"]",
            ]
        );
    }

    #[tokio::test]
    async fn notifications_get_no_answer_and_bad_json_gets_a_parse_error() {
        assert!(
            answer(
                "https://hub.test",
                Ok("t".into()),
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            )
            .await
            .is_none()
        );
        let parse = answer("https://hub.test", Ok("t".into()), "{nope")
            .await
            .unwrap();
        assert_eq!(parse["error"]["code"], -32700);
        let unauthenticated = answer(
            "https://hub.test",
            Err(xmatrix_cli_core::error::CliError::Auth("no run".into())),
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#,
        )
        .await
        .unwrap();
        assert_eq!(unauthenticated["id"], 7);
        assert_eq!(unauthenticated["error"]["code"], -32001);
    }
}
