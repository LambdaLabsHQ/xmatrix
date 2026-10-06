use super::runtime_send_authorization::{authorize_send, failure};
use super::{DaemonLocalHttpRequest, DaemonRequestBroker};
use serde_json::{Value, json};
use xmatrix_cli_core::{config, error::Result};

pub(super) async fn recover(
    broker: &DaemonRequestBroker,
    run_id: &str,
    instance_id: &str,
    execution_key: &str,
    channel_id: &str,
    execution_id: &str,
    selected_message: Option<&str>,
) -> Result<Value> {
    if uuid::Uuid::parse_str(execution_id)
        .ok()
        .is_none_or(|id| id.to_string() != execution_id)
    {
        return Err(failure("Invalid execution reference"));
    }
    let capability = {
        let registry = broker.run_registry.lock().await;
        let mut runs = registry.values().filter(|run| {
            !run.stop_in_progress
                && run.run_id.as_deref() == Some(run_id)
                && run.instance_id.as_deref() == Some(instance_id)
                && run.execution_key.as_deref() == Some(execution_key)
        });
        let run = runs
            .next()
            .ok_or_else(|| failure("Original Run is no longer available"))?;
        if runs.next().is_some() {
            return Err(failure("Original Run identity is ambiguous"));
        }
        run.request_capability
            .clone()
            .ok_or_else(|| failure("Original Run capability is unavailable"))?
    };
    let request = DaemonLocalHttpRequest {
        method: "POST".into(),
        path: "/internal/recover-reply".into(),
        query: Default::default(),
        headers: std::collections::HashMap::from([(
            "x-xmatrix-request-capability".into(),
            capability,
        )]),
        body: Vec::new(),
    };
    let authorization = authorize_send(broker, &request, channel_id, "recovery-selection").await?;
    let scope = authorization.scope;
    if scope.run_id != run_id
        || scope.instance_id != instance_id
        || scope.execution_fingerprint
            != super::runtime_send_journal::fingerprint(execution_key.as_bytes())
    {
        return Err(failure(
            "Original Run binding changed before saved reply recovery",
        ));
    }
    let execution = execution_id.to_string();
    let root = config::profile_state_dir().join("send-operations-v1");
    let candidates = tokio::task::spawn_blocking(move || {
        super::runtime_send_journal::execution_sends(&root, &scope, &execution)
    })
    .await
    .map_err(|_| failure("Saved reply inspection stopped"))?
    .map_err(failure)?;
    let selected = match selected_message {
        Some(message) => candidates.iter().find(|candidate| candidate.0 == message),
        None if candidates.len() == 1 => candidates.first(),
        _ => None,
    };
    let Some((message_id, _)) = selected else {
        return Ok(if selected_message.is_none() && candidates.len() > 1 {
            json!({"status":"selection_required", "candidates": candidates.into_iter().map(|(message_id, created_at)|
                json!({"messageId":message_id, "createdAt":created_at})).collect::<Vec<_>>()})
        } else {
            json!({"status":"unavailable", "code":"saved_reply_unavailable"})
        });
    };
    let recovered = super::runtime_send_recovery::recover(
        broker,
        &request,
        super::runtime_send_recovery::RecoveryRequest::for_send(
            broker
                .hub_url
                .clone()
                .ok_or_else(|| failure("Recovery Hub is unavailable"))?,
            channel_id.to_string(),
            message_id.clone(),
        ),
    )
    .await?;
    Ok(json!({"status":"committed", "messageId":recovered["messageId"]}))
}

pub(super) async fn execute(
    broker: Option<&DaemonRequestBroker>,
    command: super::MachineDaemonCommand,
) -> Result<super::MachineDaemonReport> {
    let super::MachineDaemonCommand::MachineRecoverReply {
        request_id,
        run_id,
        instance_id,
        execution_key,
        channel_id,
        execution_id,
        message_id,
        relay_lease,
    } = command
    else {
        return Err(failure("Invalid reply recovery command"));
    };
    let result = if let Some(broker) = broker {
        recover(
            broker,
            &run_id,
            &instance_id,
            &execution_key,
            &channel_id,
            &execution_id,
            message_id.as_deref(),
        )
        .await
        .unwrap_or_else(|_| json!({"status":"unavailable", "code":"reply_recovery_failed"}))
    } else {
        json!({"status":"unavailable", "code":"recovery_broker_unavailable"})
    };
    Ok(super::MachineDaemonReport::MachineRecoverReplyResult {
        request_id,
        run_id,
        instance_id,
        execution_key,
        channel_id,
        execution_id,
        ok: result["status"] != "unavailable",
        result,
        relay_lease,
    })
}

pub(super) async fn polled(
    hub_url: String,
    token: String,
    relay: super::SharedMachineDaemonConnection,
    journal: super::DaemonEffectJournal,
    broker: Option<DaemonRequestBroker>,
    command: super::MachineDaemonCommand,
) -> Result<()> {
    let control_id = super::polled_daemon_command_control_id(&command)
        .ok_or_else(|| failure("Recovery control ID is unavailable"))?
        .to_string();
    let Some((effect_id, _)) =
        super::prepare_polled_daemon_command(&hub_url, &token, &relay, &journal, &command).await?
    else {
        return Ok(());
    };
    let report = execute(broker.as_ref(), command).await?;
    super::report_polled_command_effect_result_http(
        &hub_url,
        &token,
        &relay,
        &journal,
        &effect_id,
        &control_id,
        report,
    )
    .await
}
