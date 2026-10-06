use xmatrix_cli_core::{
    config,
    error::{CliError, Result},
    protocol::with_route,
};

use super::runtime_send_journal::{SendScope, fingerprint};
use super::{DaemonLocalHttpRequest, DaemonRequestBroker};

pub(super) struct AuthorizedSend {
    pub scope: SendScope,
    pub execution_key: String,
    pub append_url: String,
    auth_url: String,
    auth_capability: String,
}

pub(super) fn failure(message: impl Into<String>) -> CliError {
    CliError::Relay(message.into())
}

pub(super) async fn authorize_send(
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
    channel_id: &str,
    message_id: &str,
) -> Result<AuthorizedSend> {
    if channel_id.is_empty()
        || channel_id.len() > 200
        || channel_id.chars().any(|c| c.is_control() || c == '/')
        || message_id.is_empty()
        || message_id.len() > 160
        || !message_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(failure("Send Channel or message ID is invalid"));
    }
    let context = super::daemon_request_agent_context(broker, request)
        .ok_or_else(|| failure("Send capability is no longer available"))?;
    let required = |value: &Option<String>| {
        value
            .clone()
            .filter(|v| !v.is_empty() && v.len() <= 200)
            .ok_or_else(|| failure("Send requires its exact registered Agent and Run identity"))
    };
    let agent_id = required(&context.agent_id)?;
    let run_id = required(&context.run_id)?;
    let execution_key = required(&context.execution_key)?;
    let (instance_id, auth_capability) = {
        let registry = broker.run_registry.lock().await;
        let mut matching = registry.values().filter(|run| {
            !run.stop_in_progress
                && run.request_context.as_ref() == Some(&context)
                && run.agent_id.as_deref() == Some(agent_id.as_str())
                && run.run_id.as_deref() == Some(run_id.as_str())
                && run.execution_key.as_deref() == Some(execution_key.as_str())
        });
        let matched = matching
            .next()
            .ok_or_else(|| failure("Send requires the current daemon Run"))?;
        if matching.next().is_some() {
            return Err(failure("Send Run identity is ambiguous"));
        }
        (
            required(&matched.instance_id)?,
            matched
                .auth_capability
                .clone()
                .ok_or_else(|| failure("Send requires its registered Run auth capability"))?,
        )
    };
    let hub_url = broker
        .hub_url
        .as_deref()
        .ok_or_else(|| failure("Send Hub is unavailable"))?;
    let origin = reqwest::Url::parse(hub_url)
        .map_err(|_| failure("Send Hub URL is invalid"))?
        .origin()
        .ascii_serialization();
    let scope = SendScope {
        profile_id: config::active_profile_context().map(|profile| profile.id.as_str().to_string()),
        hub_origin: origin,
        channel_id: channel_id.into(),
        message_id: message_id.into(),
        agent_id,
        instance_id,
        run_id,
        execution_fingerprint: fingerprint(execution_key.as_bytes()),
    };
    Ok(AuthorizedSend {
        scope,
        execution_key,
        append_url: with_route(
            hub_url,
            &format!("/api/channels/{}/messages", urlencoding::encode(channel_id)),
        ),
        auth_url: broker
            .auth_broker_url
            .clone()
            .ok_or_else(|| failure("Send Run authentication is unavailable"))?,
        auth_capability,
    })
}

impl AuthorizedSend {
    pub(super) async fn token(&self) -> Result<String> {
        // No Human fallback. The Hub rechecks this Run when minting and writing.
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            super::request_local_daemon_auth_token(&self.auth_url, &self.auth_capability),
        )
        .await
        .map_err(|_| failure("Send Run authentication timed out; recovery record was retained"))?
    }
}
