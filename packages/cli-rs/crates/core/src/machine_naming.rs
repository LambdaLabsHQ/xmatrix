//! A Machine name is chosen by its owner before enrollment. Hostname is never a name source.
use std::io::{IsTerminal, Write};

use crate::error::{CliError, Result};
use crate::{config, http, protocol};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineNameResponse {
    machine_id: String,
    name: Option<String>,
}

fn name_url(hub_url: &str, machine_id: &str) -> String {
    format!(
        "{}/{}/name",
        protocol::with_route(hub_url, protocol::HubRoutes::MACHINES),
        urlencoding::encode(machine_id)
    )
}

fn validate_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(CliError::Auth(
            "A Machine name is 1–64 characters without control characters".into(),
        ));
    }
    Ok(name.to_owned())
}

pub async fn machine_name(hub_url: &str, token: &str, machine_id: &str) -> Result<Option<String>> {
    let response: MachineNameResponse =
        http::request_json(&name_url(hub_url, machine_id), "GET", Some(token), None).await?;
    if response.machine_id != machine_id {
        return Err(CliError::Auth(
            "Hub returned a name for a different Machine".into(),
        ));
    }
    response.name.map(|name| validate_name(&name)).transpose()
}

pub async fn require_machine_name(hub_url: &str, token: &str, machine_id: &str) -> Result<String> {
    machine_name(hub_url, token, machine_id).await?.ok_or_else(|| CliError::Auth(
        "Name this Machine before starting its daemon. Run `xmatrix login --machine-name <name>` or name it in the desktop app.".into()))
}

/// An existing Machine keeps its chosen name unless an explicit new name is supplied.
/// A headless invocation cannot silently choose one on behalf of the owner, unless
/// the owner chose `default` for it (a setup command names a new machine by its hostname).
pub async fn ensure_machine_name(
    session: &config::CliSession,
    supplied: Option<&str>,
    default: Option<&str>,
) -> Result<String> {
    let identity = config::machine_identity_for_owner(&session.user.id).await?;
    let existing = machine_name(&session.hub_url, &session.token, &identity.machine_id).await?;
    let name = match supplied {
        Some(value) => validate_name(value)?,
        None => {
            if let Some(name) = existing {
                return Ok(name);
            }
            if let Some(name) = default.and_then(|value| validate_name(value).ok()) {
                name
            } else if !std::io::stdin().is_terminal() {
                return Err(CliError::Auth("This Machine needs a name. Pass --machine-name <name> or set XMATRIX_MACHINE_NAME; no daemon was started.".into()));
            } else {
                loop {
                    eprint!("Name this machine (for example, Laptop): ");
                    std::io::stderr().flush()?;
                    let mut line = String::new();
                    if std::io::stdin().read_line(&mut line)? == 0 {
                        return Err(CliError::Auth(
                            "A Machine name is required; no daemon was started".into(),
                        ));
                    }
                    match validate_name(&line) {
                        Ok(name) => break name,
                        Err(error) => eprintln!("{error}"),
                    }
                }
            }
        }
    };
    let response: MachineNameResponse = http::request_json(
        &name_url(&session.hub_url, &identity.machine_id),
        "POST",
        Some(&session.token),
        Some(serde_json::json!({ "name": name })),
    )
    .await?;
    if response.machine_id != identity.machine_id || response.name.as_deref() != Some(name.as_str())
    {
        return Err(CliError::Auth(
            "Hub did not confirm this Machine's chosen name".into(),
        ));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_name_requires_intentional_nonempty_bounded_text() {
        for name in ["", "  ", "Laptop\nPC", "\0name"] {
            assert!(validate_name(name).is_err());
        }
        assert!(validate_name(&"界".repeat(65)).is_err());
        assert_eq!(validate_name(&"界".repeat(64)).unwrap(), "界".repeat(64));
        assert_eq!(validate_name("  Laptop  ").unwrap(), "Laptop");
    }

    async fn name_reply(
        machine_id: &str,
        name: Option<&str>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // The client needs a process crypto provider; a test running in its
        // own process cannot rely on another test having installed it.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub = format!("http://{}", listener.local_addr().unwrap());
        let body = serde_json::json!({ "machineId": machine_id, "name": name }).to_string();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let length = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("GET /api/machines/"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token")
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        (hub, server)
    }

    #[tokio::test]
    async fn enrollment_requires_a_name_for_the_exact_machine() {
        let machine_id = "machine:chosen";
        for (returned_id, name) in [(machine_id, None), ("machine:other", Some("Laptop"))] {
            let (hub, server) = name_reply(returned_id, name).await;
            assert!(
                require_machine_name(&hub, "test-token", machine_id)
                    .await
                    .is_err()
            );
            server.await.unwrap();
        }
        let (hub, server) = name_reply(machine_id, Some("Laptop")).await;
        assert_eq!(
            require_machine_name(&hub, "test-token", machine_id)
                .await
                .unwrap(),
            "Laptop"
        );
        server.await.unwrap();
    }
}
