/// Child CLI commands inherit only a Run's broker capabilities and routing.
/// Reading/creating the Human registry here both violates isolation and fails
/// under Seatbelt. The wrapper/daemon still use normal registry admission.
fn admit_agent_cli_hub(cli: &Cli) -> error::Result<String> {
    let inherited = std::env::var("XMATRIX_HUB_URL").ok();
    let pinned = std::env::var("XMATRIX_RUN_PROFILE_ID").ok();
    let hub = validate_agent_cli_target(
        inherited.as_deref(),
        pinned.as_deref(),
        cli.profile.as_deref(),
        cli.environment,
        cli.hub_url.as_deref(),
    )?;
    config::install_agent_cli_hub(hub.clone())?;
    Ok(hub)
}

fn validate_agent_cli_target(
    inherited_hub: Option<&str>,
    pinned_profile: Option<&str>,
    selected_profile: Option<&str>,
    environment: Option<CliEnvironmentArg>,
    hub_override: Option<&str>,
) -> error::Result<String> {
    let inherited = inherited_hub
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CliError::Auth("Agent command is missing its inherited Hub binding".into())
        })?;
    let hub = resolve_target_hub_choice(None, Some(inherited), "production")?;
    if let Some(pinned) = pinned_profile {
        xmatrix_cli_core::profile::ProfileId::parse(pinned)?;
    }
    if selected_profile.is_some() && selected_profile != pinned_profile {
        return Err(CliError::Auth(
            "Agent command cannot select another installation profile".into(),
        ));
    }
    let mut requested = Vec::new();
    if let Some(environment) = environment {
        requested.push(resolve_target_hub_choice(
            Some(environment),
            None,
            "production",
        )?);
    }
    if let Some(url) = hub_override {
        requested.push(resolve_target_hub_choice(None, Some(url), "production")?);
    }
    if requested.iter().any(|requested| requested != &hub) {
        return Err(CliError::Auth(
            "Agent command cannot override its inherited Hub".into(),
        ));
    }
    Ok(hub)
}

#[cfg(test)]
mod agent_cli_admission_tests {
    use super::*;
    const PROFILE: &str = "profile:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    #[test]
    fn run_routing_cannot_select_a_sibling_profile_or_hub() {
        assert_eq!(
            validate_agent_cli_target(Some(TEST_HUB_URL), Some(PROFILE), Some(PROFILE), None, None)
                .unwrap(),
            TEST_HUB_URL
        );
        assert!(
            validate_agent_cli_target(
                Some(TEST_HUB_URL),
                Some(PROFILE),
                Some("profile:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                None,
                None
            )
            .is_err()
        );
        assert!(
            validate_agent_cli_target(
                Some(TEST_HUB_URL),
                Some(PROFILE),
                None,
                None,
                Some(DEFAULT_HUB_URL)
            )
            .is_err()
        );
        assert!(
            validate_agent_cli_target(
                Some(TEST_HUB_URL),
                Some(PROFILE),
                None,
                Some(CliEnvironmentArg::Production),
                None
            )
            .is_err()
        );
        assert!(
            validate_agent_cli_target(
                Some(TEST_HUB_URL),
                Some(PROFILE),
                None,
                Some(CliEnvironmentArg::Test),
                Some(DEFAULT_HUB_URL)
            )
            .is_err()
        );
    }

    #[test]
    fn run_routing_has_no_ambient_profile_or_hub_fallback() {
        for hub in [
            None,
            Some(""),
            Some("https://hub.invalid/path"),
            Some("https://secret@hub.invalid"),
        ] {
            assert!(validate_agent_cli_target(hub, Some(PROFILE), None, None, None).is_err());
        }
        assert!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), Some("bad-profile"), None, None, None)
                .is_err()
        );
        assert!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), None, Some(PROFILE), None, None)
                .is_err()
        );
        assert_eq!(
            validate_agent_cli_target(Some(DEFAULT_HUB_URL), None, None, None, None).unwrap(),
            DEFAULT_HUB_URL
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod agent_cli_seatbelt_tests {
    use super::*;
    use clap::Parser;
    use std::process::Command;

    #[test]
    fn agent_cli_probe_child() {
        let Ok(case) = std::env::var("XMATRIX_TEST_ADMISSION_CASE") else {
            return;
        };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let args = if case == "route" {
            vec!["xmatrix", "env", "current"]
        } else {
            vec![
                "xmatrix",
                "send",
                "00000000-0000-4000-8000-000000000001",
                "fixture",
            ]
        };
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run(Cli::parse_from(args)));
        if case != "missing-grant" {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("refusing to authenticate")
            );
        }
    }

    #[test]
    fn real_seatbelt_cli_routes_without_human_registry_and_refuses_human_credentials() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-agent-admission-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let mut policy = macos_seatbelt_profile(
            &AgentSandboxRuntime::CodexApp,
            &root,
            &root,
            &AgentSandboxGitGrants::default(),
            &agent_sandbox_temp_grants().unwrap(),
            true,
        );
        let executable = std::env::current_exe().unwrap();
        policy.push_str(&format!(
            "\n{}",
            sandbox_allow_literal("file-read*", &executable)
        ));
        for case in ["route", "missing-grant", "send"] {
            let broker = (case == "send").then(start_fixture_broker);
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command
                .args(["-p", &policy])
                .arg(&executable)
                .args([
                    "--exact",
                    "agent_cli_seatbelt_tests::agent_cli_probe_child",
                    "--nocapture",
                ])
                .env_clear()
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("XMATRIX_TEST_ADMISSION_CASE", case)
                .env("XMATRIX_AGENT_SESSION", "1")
                .env("XMATRIX_HUB_URL", "http://127.0.0.1:9")
                .env(
                    "XMATRIX_RUN_PROFILE_ID",
                    "profile:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                )
                .current_dir(&root);
            if let Some((url, _)) = &broker {
                command
                    .env("XMATRIX_DAEMON_AUTH_URL", url)
                    .env("XMATRIX_DAEMON_AUTH_CAPABILITY", "fixture-auth")
                    .env("XMATRIX_DAEMON_REQUEST_URL", url)
                    .env("XMATRIX_DAEMON_REQUEST_CAPABILITY", "fixture-request")
                    .env("XMATRIX_AGENT_ID", "agent:fixture")
                    .env("XMATRIX_AGENT_NAME", "fixture")
                    .env("XMATRIX_AGENT_INSTANCE_ID", "instance:fixture")
                    .env("XMATRIX_RUN_ID", "run:fixture")
                    .env("XMATRIX_EXECUTION_KEY", "execution-fixture");
            }
            let output = command.output().unwrap();
            let broker_ok = broker
                .map(|(_, server)| server.join().is_ok())
                .unwrap_or(true);
            assert!(
                output.status.success(),
                "{case}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(broker_ok, "fixture broker failed");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    fn start_fixture_broker() -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for sequence in 0..2 {
                let deadline = Instant::now() + Duration::from_secs(15);
                let mut socket = loop {
                    if let Ok((socket, _)) = listener.accept() {
                        break socket;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "fixture broker request {sequence} timed out"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let body_at = loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..at]);
                        let length =
                            crate::runtime_http_fixture::content_length(&headers).unwrap_or(0);
                        if bytes.len() >= at + 4 + length {
                            break at + 4;
                        }
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..body_at]);
                let value = if sequence == 0 {
                    assert!(headers.starts_with("GET /auth/token "));
                    assert!(headers.contains("x-xmatrix-auth-capability: fixture-auth"));
                    serde_json::json!({"token":"fixture-run-token"})
                } else {
                    assert!(headers.starts_with("POST /request/hub-json "));
                    assert!(headers.contains("x-xmatrix-request-capability: fixture-request"));
                    let envelope: Value = serde_json::from_slice(&bytes[body_at..]).unwrap();
                    assert_eq!(envelope["token"], "fixture-run-token");
                    assert_eq!(envelope["journalSend"], true);
                    assert_eq!(envelope["body"]["senderRunId"], "run:fixture");
                    assert_eq!(envelope["body"]["senderExecutionKey"], "execution-fixture");
                    assert_eq!(
                        envelope["url"],
                        "http://127.0.0.1:9/api/channels/00000000-0000-4000-8000-000000000001/messages"
                    );
                    serde_json::json!({"value":{"message":{"messageId":envelope["body"]["clientMessageId"],
                        "channelId":"00000000-0000-4000-8000-000000000001"}}})
                };
                let body = value.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (address, server)
    }

    #[test]
    fn lineage_markers_are_discoverable_but_neither_credentials_nor_tickets_are_readable() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-marker-policy-{}", uuid::Uuid::new_v4()));
        let markers = root.join("owner-request-executions");
        std::fs::create_dir_all(markers.join("tickets")).unwrap();
        std::fs::write(markers.join("123.json"), "marker").unwrap();
        std::fs::write(markers.join("tickets/opaque"), "private-ticket").unwrap();
        std::fs::write(root.join("session.json"), "private-session").unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let markers = root.join("owner-request-executions");
        let mut lines = vec!["(version 1)".into(), "(allow default)".into()];
        push_agent_credential_path_denies_with_markers(&mut lines, &root, &markers);
        let output = Command::new("/usr/bin/sandbox-exec").args(["-p", &lines.join("\n"), "/bin/sh", "-c",
            "ls \"$1\" >/dev/null && test -f \"$1/123.json\" && ! cat \"$1/123.json\" && ! cat \"$1/tickets/opaque\" && ! ls \"$1/tickets\" && ! cat \"$2/session.json\" && ! touch \"$1/456.json\"", "_"])
            .arg(&markers).arg(&root).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod runtime_http_fixture {
    include!("../../core/tests/support/http_fixture.rs");
}
