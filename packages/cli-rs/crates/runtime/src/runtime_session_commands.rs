//! `xmatrix session` — how the Desktop App hands a Hub session to the CLI's
//! credential store and reads back the resolved local context, so session
//! files, their migration, and profile roots have exactly one implementation.

use serde::Deserialize;
use serde_json::{Value, json};
use xmatrix_cli_args::SessionCommand;
use xmatrix_cli_core::config::{
    self, CliSession, load_session_for_hub, normalized_hub_origin, save_session,
};
use xmatrix_cli_core::daemon_auth::{self, DaemonSessionReloadOutcome};
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::profile::{ProfileContext, ProfileStateKind};
use xmatrix_cli_core::protocol::AuthUser;

/// The Hub's CLI session exchange response, as the App receives it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionImport {
    pub token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub user: AuthUser,
    pub hub_url: String,
    #[serde(default)]
    pub relay_url: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

pub(crate) fn parse_session_import(payload: &str) -> error::Result<SessionImport> {
    let import: SessionImport = serde_json::from_str(payload.trim_start_matches('\u{feff}'))
        .map_err(|error| CliError::Auth(format!("Invalid session payload: {error}")))?;
    if import.token.trim().is_empty() || import.user.id.trim().is_empty() {
        return Err(CliError::Auth(
            "Session payload must include a token and a user id".into(),
        ));
    }
    Ok(import)
}

/// A profile is bound to one Hub; credentials for another Hub are refused
/// rather than stored under the wrong root.
pub(crate) fn ensure_hub_matches(payload_hub: &str, admitted_hub: &str) -> error::Result<()> {
    let payload = normalized_hub_origin(payload_hub);
    let admitted = normalized_hub_origin(admitted_hub);
    if payload != admitted {
        return Err(CliError::Auth(format!(
            "This profile is bound to {admitted}; refusing credentials for {payload}"
        )));
    }
    Ok(())
}

fn reload_outcome_name(outcome: &DaemonSessionReloadOutcome) -> &'static str {
    match outcome {
        DaemonSessionReloadOutcome::Reloaded => "reloaded",
        DaemonSessionReloadOutcome::AlreadyCurrent => "already-current",
        DaemonSessionReloadOutcome::Unavailable => "unavailable",
        DaemonSessionReloadOutcome::Unsupported => "unsupported",
    }
}

/// The saved session minus its tokens: everything a client needs to bind a
/// local namespace, nothing it could leak.
pub(crate) fn session_summary(session: &CliSession, with_token: bool) -> Value {
    let mut summary = json!({
        "hubUrl": session.hub_url,
        "relayUrl": session.relay_url,
        "user": session.user,
        "updatedAt": session.updated_at,
        "expiresAt": session.expires_at,
    });
    if with_token {
        summary["token"] = Value::String(session.token.clone());
    }
    summary
}

pub(crate) fn profile_summary(context: &ProfileContext) -> Value {
    json!({
        "id": context.id.as_str(),
        "name": context.name,
        "hubUrl": context.hub_origin,
        "stateRoot": context.state_root.as_path(),
        "revision": context.registry_revision,
        "stateKind": match context.state_kind {
            ProfileStateKind::LegacyRoot => "legacy-root",
            ProfileStateKind::Isolated => "isolated",
        },
    })
}

pub(crate) async fn cmd_session(hub_url: &str, command: SessionCommand) -> error::Result<()> {
    match command {
        SessionCommand::Import { stdin, json } => {
            if !stdin {
                return Err(CliError::Auth(
                    "`xmatrix session import` reads the session JSON from stdin; pass --stdin"
                        .into(),
                ));
            }
            let mut payload = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut payload)?;
            let import = parse_session_import(&payload)?;
            ensure_hub_matches(&import.hub_url, hub_url)?;
            let saved = save_session(
                import.token,
                import.refresh_token,
                import.user,
                import.hub_url,
                import.relay_url,
                import.expires_at,
            )
            .await?;
            // The doorbell: a running daemon re-reads the file it already
            // trusts. A missing daemon is a normal first-run state, not an error.
            let identity = config::machine_identity_for_owner(&saved.user.id).await?;
            let name = xmatrix_cli_core::machine_naming::machine_name(
                &saved.hub_url,
                &saved.token,
                &identity.machine_id,
            )
            .await?;
            let daemon = if name.is_none() {
                "machine-name-required"
            } else {
                match daemon_auth::reload_saved_session_in_local_daemon().await {
                    Ok(outcome) => reload_outcome_name(&outcome),
                    Err(_) => "unavailable",
                }
            };
            if json {
                println!(
                    "{}",
                    json!({
                        "hubUrl": saved.hub_url,
                        "userId": saved.user.id,
                        "updatedAt": saved.updated_at,
                        "expiresAt": saved.expires_at,
                        "daemon": daemon,
                    })
                );
            } else {
                println!(
                    "Saved xMatrix session for {} at {}; daemon: {daemon}",
                    saved.user.email, saved.hub_url
                );
            }
            Ok(())
        }
        SessionCommand::Show { json, with_token } => {
            let report = session_show_report(hub_url, with_token).await;
            if json {
                println!("{report}");
            } else {
                println!("Hub: {}", report["hubUrl"].as_str().unwrap_or_default());
                match report["profile"].as_object() {
                    Some(profile) => println!(
                        "Profile: {} ({}) revision {}",
                        profile["name"].as_str().unwrap_or_default(),
                        profile["id"].as_str().unwrap_or_default(),
                        profile["revision"]
                    ),
                    None => println!("Profile: (installation default)"),
                }
                match report["session"].as_object() {
                    Some(session) => println!(
                        "Session: {} (expires {})",
                        session["user"]["email"].as_str().unwrap_or_default(),
                        session["expiresAt"].as_str().unwrap_or_default()
                    ),
                    None => println!("Session: none saved for this Hub"),
                }
                if let Some(machine_id) = report["machineId"].as_str() {
                    println!("Machine: {machine_id}");
                }
            }
            Ok(())
        }
    }
}

pub(crate) async fn session_show_report(hub_url: &str, with_token: bool) -> Value {
    let session = load_session_for_hub(hub_url).await;
    // The Machine this host is for the signed-in owner: exactly the derived id
    // its daemon registers with the Hub, or none. A config's stored id is an
    // earlier minted one awaiting adoption and never stands in for it.
    let machine_id = match session.as_ref() {
        Some(session) => config::machine_identity_for_owner(&session.user.id)
            .await
            .ok()
            .map(|identity| identity.machine_id),
        None => None,
    };
    json!({
        "hubUrl": normalized_hub_origin(hub_url),
        "profile": config::process_profile_context().map(profile_summary),
        "session": session
            .as_ref()
            .map(|session| session_summary(session, with_token)),
        "machineId": machine_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> String {
        json!({
            "token": "tok-1",
            "refreshToken": "ref-1",
            "user": { "id": "user:1", "email": "a@example.com", "name": "A" },
            "hubUrl": "https://xmatrix-hub.xmatrix.sh",
            "relayUrl": "wss://xmatrix-hub.xmatrix.sh/ws"
        })
        .to_string()
    }

    #[test]
    fn a_session_payload_round_trips_and_tolerates_a_bom() {
        let import = parse_session_import(&format!("\u{feff}{}", payload())).unwrap();
        assert_eq!(import.token, "tok-1");
        assert_eq!(import.refresh_token.as_deref(), Some("ref-1"));
        assert_eq!(import.user.id, "user:1");
        assert_eq!(import.hub_url, "https://xmatrix-hub.xmatrix.sh");
        assert_eq!(import.relay_url, "wss://xmatrix-hub.xmatrix.sh/ws");
        assert!(import.expires_at.is_none());
    }

    #[test]
    fn a_payload_without_a_token_or_user_is_refused() {
        let no_token = json!({ "token": " ", "user": { "id": "user:1", "email": "a@b" }, "hubUrl": "https://h" });
        assert!(parse_session_import(&no_token.to_string()).is_err());
        let no_user =
            json!({ "token": "t", "user": { "id": "", "email": "a@b" }, "hubUrl": "https://h" });
        assert!(parse_session_import(&no_user.to_string()).is_err());
        assert!(parse_session_import("not json").is_err());
    }

    #[test]
    fn hub_binding_compares_origins_not_spellings() {
        ensure_hub_matches(
            "https://xmatrix-hub.xmatrix.sh/",
            "wss://xmatrix-hub.xmatrix.sh/ws",
        )
        .unwrap();
        let error = ensure_hub_matches("https://other.example", "https://xmatrix-hub.xmatrix.sh")
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("bound to https://xmatrix-hub.xmatrix.sh"),
            "{error}"
        );
        assert!(error.contains("https://other.example"), "{error}");
    }

    #[test]
    fn the_session_summary_never_carries_tokens() {
        let session = CliSession {
            token: "secret-token".into(),
            refresh_token: Some("secret-refresh".into()),
            user: AuthUser {
                id: "user:1".into(),
                email: "a@example.com".into(),
                name: None,
            },
            hub_url: "https://xmatrix-hub.xmatrix.sh".into(),
            relay_url: "wss://xmatrix-hub.xmatrix.sh/ws".into(),
            updated_at: "1".into(),
            expires_at: "2".into(),
        };
        let summary = session_summary(&session, false).to_string();
        assert!(!summary.contains("secret-token"));
        assert!(!summary.contains("secret-refresh"));
        assert!(!summary.contains("\"token\""));
        assert!(summary.contains("\"hubUrl\":\"https://xmatrix-hub.xmatrix.sh\""));
        assert!(summary.contains("\"id\":\"user:1\""));
        let with_token = session_summary(&session, true).to_string();
        assert!(with_token.contains("\"token\":\"secret-token\""));
        assert!(!with_token.contains("secret-refresh"));
    }

    // The env lock is held around the runtime, never across an await inside it.
    #[test]
    fn session_show_names_the_machine_the_daemon_registers() {
        let _guard = crate::tests::test_process_env_lock();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let config_dir =
                std::env::temp_dir().join(format!("xmatrix-session-show-{}", uuid::Uuid::new_v4()));
            // Tests hold the shared process env lock while mutating process-wide environment.
            unsafe {
                std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
            }
            let hub = "https://hub.example.test";
            // An earlier CLI's minted id in the config never stands in for the Machine.
            let config_path = config::config_path();
            std::fs::create_dir_all(config_path.parent().expect("config dir")).expect("config dir");
            std::fs::write(&config_path, r#"{"machineId":"legacy-minted-id"}"#).expect("config");
            let signed_out = session_show_report(hub, false).await;
            assert!(signed_out["machineId"].is_null());

            let user = AuthUser {
                id: "user-session-show".into(),
                email: "a@example.test".into(),
                name: None,
            };
            save_session("token".into(), None, user, hub.into(), String::new(), None)
                .await
                .expect("session saved");
            let report = session_show_report(hub, false).await;
            let identity = config::machine_identity_for_owner("user-session-show")
                .await
                .expect("identity");
            assert_eq!(report["machineId"], json!(identity.machine_id));
            assert_ne!(report["machineId"], json!("legacy-minted-id"));
            assert!(identity.machine_id.starts_with("machine:"));

            unsafe {
                std::env::remove_var("XMATRIX_CONFIG_DIR");
            }
            let _ = std::fs::remove_dir_all(&config_dir);
        });
    }

    #[test]
    fn reload_outcomes_have_stable_names() {
        assert_eq!(
            reload_outcome_name(&DaemonSessionReloadOutcome::Reloaded),
            "reloaded"
        );
        assert_eq!(
            reload_outcome_name(&DaemonSessionReloadOutcome::AlreadyCurrent),
            "already-current"
        );
        assert_eq!(
            reload_outcome_name(&DaemonSessionReloadOutcome::Unavailable),
            "unavailable"
        );
        assert_eq!(
            reload_outcome_name(&DaemonSessionReloadOutcome::Unsupported),
            "unsupported"
        );
    }
}
