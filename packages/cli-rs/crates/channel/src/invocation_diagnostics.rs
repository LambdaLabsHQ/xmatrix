use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::{http, protocol::with_route};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    phase: String,
    at: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Retry {
    attempt: u32,
    kind: Option<String>,
    next_attempt_at: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    run_status: String,
    instance_status: Option<String>,
    host_name: Option<String>,
    updated_at: String,
    finished_at: Option<String>,
    phase: Option<String>,
    observed_at: Option<String>,
    evidence_stale: Option<bool>,
    wrapper_ready_at: Option<String>,
    wrapper_version: Option<String>,
    error_code: Option<String>,
    #[serde(default)]
    operation_failure: Option<xmatrix_cli_core::protocol::AgentOperationFailure>,
    diagnostic_id: Option<String>,
    connection_retry: Option<Retry>,
    #[serde(default)]
    startup_steps: Vec<Step>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    run_id: String,
    instance_id: Option<String>,
    name: Option<String>,
    activity: Activity,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    launch_id: String,
    channel_id: String,
    source_message_id: String,
    run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    target_name: Option<String>,
    state: String,
    activity: Option<Activity>,
    created_at: String,
    prepared_at: Option<String>,
    command_durable_at: Option<String>,
    admitted_at: Option<String>,
    spawned_at: Option<String>,
    connected_at: Option<String>,
    first_reply_at: Option<String>,
    error_code: Option<String>,
    error_stage: Option<String>,
    retryable: bool,
    #[serde(default)]
    attempt: u32,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Rejection {
    invocation_id: String,
    channel_id: String,
    source_message_id: String,
    target_ref: String,
    code: String,
    message: String,
    rejected_at: String,
    evidence_expires_at: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    kind: String,
    limit: u16,
    has_older_messages: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Continuation {
    schema_version: u32,
    run_id: String,
    channel_id: String,
    source_message_id: String,
    source_message_version: u64,
    kind: String,
    source_instance_id: String,
    source_run_id: String,
    source_name: String,
    source_ordinal: u64,
    target_instance_id: String,
    target_name: String,
    created_at: String,
    run_created_at: Option<String>,
    predecessor_exited_at: Option<String>,
    handoff_fenced_at: Option<String>,
    /// A reborn's durable intent; present from acceptance, before any successor Run.
    reborn: Option<RebornProgress>,
    /// The successor Run's evidence; absent until it exists.
    activity: Option<Activity>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RebornProgress {
    state: String,
    stop_required: bool,
    error_code: Option<String>,
    updated_at: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Execution {
    id: String,
    channel_id: String,
    source_message_id: String,
    source_entity_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_input_version: Option<u64>,
    run_id: String,
    instance_id: String,
    agent_name: Option<String>,
    channel_instance_id: Option<String>,
    execution_id: String,
    revision: u64,
    state: String,
    input_disposition: Option<String>,
    started_at: String,
    updated_at: String,
    finished_at: Option<String>,
    observed_at: String,
    run_status: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: String,
    channel_id: String,
    source_message_id: String,
    source_entity_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_input_version: Option<u64>,
    target_name: String,
    channel_instance_id: String,
    resolution: String,
    instance_id: Option<String>,
    run_id: Option<String>,
    run_status: Option<String>,
    created_at: String,
}
#[derive(Debug, Deserialize, Serialize)]
struct ServerVersion {
    id: String,
    tag: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    server_version: Option<ServerVersion>,
    reader_version: Option<String>,
    generated_at: String,
    channel_id: String,
    source_message_ids: Vec<String>,
    selection: Selection,
    run: Option<Run>,
    launches: Vec<Launch>,
    #[serde(default)]
    rejections: Vec<Rejection>,
    #[serde(default)]
    continuations: Vec<Continuation>,
    #[serde(default)]
    executions: Vec<Execution>,
    #[serde(default)]
    targets: Vec<Target>,
    next_cursor: Option<String>,
}

pub async fn cmd_diagnose(
    hub_url: &str,
    token: &str,
    target: &str,
    force_run: bool,
    limit: u16,
    message: Option<&str>,
    json: bool,
) -> Result<()> {
    let mut report = tokio::time::timeout(
        Duration::from_secs(30),
        load(hub_url, token, target, force_run, limit, message),
    )
    .await
    .map_err(|_| CliError::Relay("Invocation diagnosis timed out; nothing was changed".into()))??;
    report.reader_version = Some(xmatrix_cli_core::version::current().to_string());
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_report(&report);
    }
    Ok(())
}

async fn load(
    hub_url: &str,
    token: &str,
    target: &str,
    force_run: bool,
    limit: u16,
    message: Option<&str>,
) -> Result<Report> {
    let run_mode = force_run || target.starts_with("run:");
    if run_mode && message.is_some() {
        return Err(CliError::Relay(
            "--message applies to Channel diagnosis only".into(),
        ));
    }
    let channel_id = if run_mode {
        None
    } else {
        Some(super::resolve_channel_reference(hub_url, token, target).await?)
    };
    let mut body = if run_mode {
        serde_json::json!({"runId": target, "limit": limit})
    } else {
        serde_json::json!({"channelId": channel_id, "limit": limit})
    };
    if let Some(message) = message {
        body["sourceMessageIds"] = serde_json::json!([message]);
    }
    let mut combined: Option<Report> = None;
    let mut cursors = HashSet::new();
    let mut launches = HashSet::new();
    let mut rejections = HashSet::new();
    let mut continuations = HashSet::new();
    let mut executions = HashSet::new();
    let mut targets = HashSet::new();
    for _ in 0..50 {
        let mut page: Report = http::request_json(
            &with_route(hub_url, "/api/invocations/diagnostics"),
            "POST",
            Some(token),
            Some(body.clone()),
        )
        .await?;
        if page.schema_version != 1
            || page.source_message_ids.len() > 100
            || page.launches.len() > 100
            || page.rejections.len() > 100
            || page.continuations.len() > 100
            || page.executions.len() > 100
            || page.targets.len() > 100
            || channel_id.as_ref().is_some_and(|id| id != &page.channel_id)
            || run_mode && page.run.as_ref().is_none_or(|run| run.run_id != target)
            || combined.as_ref().is_some_and(|first| {
                first.channel_id != page.channel_id
                    || first.source_message_ids != page.source_message_ids
            })
        {
            return Err(CliError::Relay(
                "Diagnostic response scope is invalid".into(),
            ));
        }
        let selected: HashSet<_> = page.source_message_ids.iter().collect();
        for launch in &page.launches {
            if launch.channel_id != page.channel_id
                || !selected.contains(&launch.source_message_id)
                || run_mode && launch.run_id != target
                || !launches.insert(launch.launch_id.clone())
            {
                return Err(CliError::Relay(
                    "Diagnostic launch page is inconsistent".into(),
                ));
            }
        }
        for rejection in &page.rejections {
            if run_mode
                || rejection.channel_id != page.channel_id
                || !selected.contains(&rejection.source_message_id)
                || !rejections.insert(rejection.invocation_id.clone())
            {
                return Err(CliError::Relay(
                    "Diagnostic rejection page is inconsistent".into(),
                ));
            }
        }
        let next = page.next_cursor.take();
        for continuation in &page.continuations {
            if continuation.schema_version != 1
                || continuation.channel_id != page.channel_id
                || !selected.contains(&continuation.source_message_id)
                || run_mode && continuation.run_id != target
                || !continuations.insert(continuation.run_id.clone())
            {
                return Err(CliError::Relay(
                    "Diagnostic continuation page is inconsistent".into(),
                ));
            }
        }
        for execution in &page.executions {
            if execution.channel_id != page.channel_id
                || !selected.contains(&execution.source_message_id)
                || run_mode && execution.run_id != target
                || !executions.insert(execution.id.clone())
            {
                return Err(CliError::Relay(
                    "Diagnostic execution page is inconsistent".into(),
                ));
            }
        }
        for addressed in &page.targets {
            if addressed.channel_id != page.channel_id
                || !selected.contains(&addressed.source_message_id)
                || run_mode && addressed.run_id.as_deref() != Some(target)
                || !targets.insert(addressed.id.clone())
            {
                return Err(CliError::Relay(
                    "Diagnostic target page is inconsistent".into(),
                ));
            }
        }
        body["sourceMessageIds"] = serde_json::json!(page.source_message_ids);
        if let Some(first) = combined.as_mut() {
            first.launches.append(&mut page.launches);
            first.rejections.append(&mut page.rejections);
            first.continuations.append(&mut page.continuations);
            first.executions.append(&mut page.executions);
            first.targets.append(&mut page.targets);
        } else {
            combined = Some(page);
        }
        match next {
            None => return Ok(combined.expect("the first page was stored")),
            Some(cursor)
                if !cursor.is_empty() && cursor.len() <= 2000 && cursors.insert(cursor.clone()) =>
            {
                body["cursor"] = serde_json::json!(cursor)
            }
            _ => {
                return Err(CliError::Relay(
                    "Diagnostic pagination did not advance".into(),
                ));
            }
        }
    }
    Err(CliError::Relay(
        "Diagnostic pagination exceeded its bound; use --message or --run".into(),
    ))
}

fn safe(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control())
        .take(300)
        .collect()
}
fn print_activity(activity: &Activity) {
    println!(
        "  Agent wrapper version: {}",
        safe(activity.wrapper_version.as_deref().unwrap_or("unreported"))
    );
    println!(
        "  Run record: {} | wrapper phase: {}",
        safe(&activity.run_status),
        safe(activity.phase.as_deref().unwrap_or("unconfirmed"))
    );
    if activity.evidence_stale == Some(true) {
        println!("  Machine evidence is stale; current execution is not confirmed.");
    }
    for step in &activity.startup_steps {
        println!("  {}  {}", safe(&step.at), safe(&step.phase));
    }
    if let Some(retry) = &activity.connection_retry {
        println!(
            "  {} retries: {}",
            safe(retry.kind.as_deref().unwrap_or("Connection")),
            retry.attempt
        );
        if let Some(next) = &retry.next_attempt_at {
            println!("  Retry scheduled: {}", safe(next));
        }
    }
    if let Some(failure) = &activity.operation_failure {
        println!("  Failed step: {}", safe(&failure.stage));
        if let Some(origin) = &failure.origin_stage {
            println!("  Failure origin: {}", safe(origin));
        }
    }
    if let Some(code) = &activity.error_code {
        println!("  Error: {}", safe(code));
    }
    if let Some(id) = &activity.diagnostic_id {
        println!("  Diagnostic: {}", safe(id));
    }
}
fn print_report(report: &Report) {
    if let Some(version) = &report.reader_version {
        println!("Diagnostic CLI: {}", safe(version));
    }
    if let Some(version) = &report.server_version {
        println!(
            "Hub version: {}{}",
            safe(&version.id),
            version
                .tag
                .as_ref()
                .map(|tag| format!(" ({})", safe(tag)))
                .unwrap_or_default()
        );
    }
    println!(
        "Channel: {}\nObserved: {}",
        safe(&report.channel_id),
        safe(&report.generated_at)
    );
    if report.selection.kind == "recent-messages" {
        println!(
            "Selection: latest {} messages{}",
            report.selection.limit,
            if report.selection.has_older_messages {
                " (use --message or a Run ID for older invocations)"
            } else {
                ""
            }
        );
    }
    if let Some(run) = &report.run {
        println!("Run: {}", safe(&run.run_id));
        print_activity(&run.activity);
    }
    for launch in &report.launches {
        println!(
            "\n@{} · launch record: {}",
            safe(
                launch
                    .target_name
                    .as_deref()
                    .or(launch.instance_id.as_deref())
                    .unwrap_or("Agent")
            ),
            safe(&launch.state)
        );
        println!(
            "  Launch: {}\n  Source message: {}",
            safe(&launch.launch_id),
            safe(&launch.source_message_id)
        );
        for (name, at) in [
            ("prepared", &launch.prepared_at),
            ("command stored", &launch.command_durable_at),
            ("machine admitted", &launch.admitted_at),
            ("process created", &launch.spawned_at),
            ("server connection claim", &launch.connected_at),
            ("first reply committed", &launch.first_reply_at),
        ] {
            if let Some(at) = at {
                println!("  {}  {name}", safe(at));
            }
        }
        if let Some(activity) = &launch.activity {
            print_activity(activity);
        }
        if let Some(code) = &launch.error_code {
            println!("  Launch error: {}", safe(code));
        }
        if let Some(stage) = &launch.error_stage {
            println!("  Failed stage: {}", safe(stage));
        }
        if launch.attempt > 0 {
            println!("  Command delivery retries: {}", launch.attempt);
        }
        if launch.retryable && launch.state == "failed" {
            println!("  Startup retry is available in the invocation details.");
        }
    }
    for rejection in &report.rejections {
        println!(
            "\n@{} · not started\n  {}: {}",
            safe(&rejection.target_ref),
            safe(&rejection.code),
            safe(&rejection.message)
        );
    }
    for continuation in &report.continuations {
        println!(
            "\n@{} → @{} · {}",
            safe(&continuation.source_name),
            safe(&continuation.target_name),
            safe(&continuation.kind)
        );
        println!(
            "  Run: {}\n  Source message: {}",
            safe(&continuation.run_id),
            safe(&continuation.source_message_id)
        );
        for (name, at) in [
            (
                "previous process stopped",
                continuation.predecessor_exited_at.as_ref(),
            ),
            ("handoff recorded", continuation.handoff_fenced_at.as_ref()),
            (
                "successor Run created",
                continuation.run_created_at.as_ref().or(
                    // A continuation without an intent is its successor Run.
                    continuation
                        .reborn
                        .is_none()
                        .then_some(&continuation.created_at),
                ),
            ),
        ] {
            if let Some(at) = at {
                println!("  {}  {name}", safe(at));
            }
        }
        if let Some(reborn) = &continuation.reborn {
            println!(
                "  Reborn: {} (stop {}; updated {}){}",
                safe(&reborn.state),
                if reborn.stop_required {
                    "required"
                } else {
                    "not required"
                },
                safe(&reborn.updated_at),
                reborn
                    .error_code
                    .as_deref()
                    .map(|code| format!(" · {}", safe(code)))
                    .unwrap_or_default()
            );
        }
        match &continuation.activity {
            Some(activity) => print_activity(activity),
            None => println!("  Successor Run: not created yet"),
        }
    }
    for target in &report.targets {
        println!(
            "\n@{}:{} · target {}\n  Source message: {}",
            safe(&target.target_name),
            safe(&target.channel_instance_id),
            safe(&target.resolution),
            safe(&target.source_message_id)
        );
        if let Some(run_id) = &target.run_id {
            println!("  Original Run: {}", safe(run_id));
        }
    }
    for execution in &report.executions {
        println!(
            "\nExecution: {} · {}\n  Run: {}\n  Instance: {}\n  Source message: {} (version {})",
            safe(&execution.execution_id),
            safe(&execution.state),
            safe(&execution.run_id),
            safe(&execution.instance_id),
            safe(&execution.source_message_id),
            execution.source_entity_version
        );
        println!(
            "  Started: {}\n  Updated: {}\n  Observed: {}",
            safe(&execution.started_at),
            safe(&execution.updated_at),
            safe(&execution.observed_at)
        );
        if let Some(disposition) = &execution.input_disposition {
            println!("  Input: {}", safe(disposition));
        }
        if let Some(at) = &execution.finished_at {
            println!("  Finished: {}", safe(at));
        }
    }
    if report.run.is_none()
        && report.launches.is_empty()
        && report.rejections.is_empty()
        && report.continuations.is_empty()
        && report.executions.is_empty()
        && report.targets.is_empty()
    {
        println!("No invocation evidence in this selection.");
    }
}

/// Uses the Run token through the dedicated, server-authorized evidence reader.
/// It cannot read generic private blobs or impersonate the source author.
pub async fn cmd_decision_evidence(
    hub_url: &str,
    token: &str,
    target: &str,
    message: &str,
    ref_id: &str,
) -> Result<()> {
    let channel = super::resolve_channel_reference(hub_url, token, target).await?;
    let mut path = format!(
        "/api/channels/{}/messages/{}/decision-evidence",
        urlencoding::encode(&channel),
        urlencoding::encode(message)
    );
    if !ref_id.is_empty() {
        path.push_str(&format!("?refId={}", urlencoding::encode(ref_id)));
    }
    let value: serde_json::Value = tokio::time::timeout(
        Duration::from_secs(30),
        http::request_json(&with_route(hub_url, &path), "GET", Some(token), None),
    )
    .await
    .map_err(|_| CliError::Relay("Decision evidence read timed out".into()))??;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    mod http_sync_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/support/http_sync_fixture.rs"
        ));
    }

    mod http_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/support/http_fixture.rs"
        ));
    }

    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn diagnosis_uses_only_the_read_endpoint_and_drops_unknown_private_fields() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = http_sync_fixture::accept_before(
                &listener,
                Duration::from_secs(5),
                "diagnostic fixture did not receive request",
            );
            // Accepted sockets inherit nonblocking mode on Windows. The bounded
            // fixture read below needs blocking mode with its explicit timeout.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(header_end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = http_fixture::content_length(&headers).unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.starts_with("POST /api/invocations/diagnostics "));
            let body: serde_json::Value =
                serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["runId"], "run:one");
            let json = serde_json::json!({"schemaVersion":1,"generatedAt":"2026-09-13T00:00:00Z", "channelId":"channel",
                "sourceMessageIds":["message"],"selection":{"kind":"run","limit":1,"hasOlderMessages":false},
                "run":{"runId":"run:one","activity":{"runStatus":"exited","updatedAt":"2026-09-13T00:00:00Z",
                    "phase":"wrapper_startup_failed","token":"PRIVATE_SENTINEL","cwd":"/private/path"}},
                "launches":[{"launchId":"launch","channelId":"channel","sourceMessageId":"message","runId":"run:one",
                    "state":"connected","createdAt":"2026-09-13T00:00:00Z","retryable":false,
                    "sourceMention":"@agent:new:/private/path","errorMessage":"PRIVATE_SENTINEL"}],
                "targets":[{"id":"target", "channelId":"channel", "sourceMessageId":"message", "sourceEntityVersion":1,
                    "targetName":"agent", "channelInstanceId":"1", "resolution":"resolved", "runId":"run:one",
                    "createdAt":"2026-09-13T00:00:00Z", "sourceMention":"PRIVATE_SENTINEL", "sourceBodyHash":"PRIVATE_SENTINEL"}],
                "executions":[{"id":"binding", "channelId":"channel", "sourceMessageId":"message",
                    "sourceEntityVersion":1, "sourceBodyHash":"PRIVATE_SENTINEL", "runId":"run:one",
                    "instanceId":"instance", "executionId":"execution", "revision":2,
                    "state":"completed", "inputDisposition":"submitted", "runStatus":"exited",
                    "startedAt":"2026-09-13T00:00:00Z", "updatedAt":"2026-09-13T00:00:01Z",
                    "observedAt":"2026-09-13T00:00:02Z"}],
                "rejections":[],"nextCursor":null,"rawStderr":"PRIVATE_SENTINEL"}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", json.len(), json).unwrap();
        });
        let report = load(
            &format!("http://{address}"),
            "fixture-token",
            "run:one",
            false,
            20,
            None,
        )
        .await
        .unwrap();
        server.join().unwrap();
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("wrapper_startup_failed"));
        assert_eq!(report.executions.len(), 1);
        assert_eq!(report.targets.len(), 1);
        assert_eq!(report.executions[0].state, "completed");
        assert!(!json.contains("PRIVATE_SENTINEL"));
        assert!(!json.contains("/private/path"));
        assert!(!json.contains("sourceMention"));
    }

    #[test]
    fn terminal_output_cannot_emit_control_sequences() {
        assert_eq!(safe("agent\x1b[2J\nname"), "agent[2Jname");
        assert_eq!(safe(&"a".repeat(1000)).len(), 300);
    }

    #[test]
    fn an_accepted_reborn_reports_before_its_successor_run_exists() {
        let record: Continuation = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "kind": "reborn", "runId": "successor", "channelId": "channel",
            "sourceMessageId": "message", "sourceMessageVersion": 1,
            "sourceInstanceId": "instance-a", "sourceRunId": "prior", "sourceName": "Alpha", "sourceOrdinal": 1,
            "targetInstanceId": "instance-a", "targetName": "Alpha",
            "createdAt": "2026-09-13T00:00:00Z",
            "reborn": { "state": "failed", "stopRequired": true, "errorCode": "reborn_spawn_failed",
                "updatedAt": "2026-09-13T00:00:05Z" },
        }))
        .unwrap();
        assert!(record.activity.is_none());
        let reborn = record.reborn.expect("reborn progress");
        assert_eq!(reborn.state, "failed");
        assert_eq!(reborn.error_code.as_deref(), Some("reborn_spawn_failed"));
    }

    #[test]
    fn continuation_report_keeps_source_identity_without_private_snapshot_fields() {
        let record: Continuation = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "kind": "handoff", "runId": "successor", "channelId": "channel",
            "sourceMessageId": "message", "sourceMessageVersion": 1,
            "sourceInstanceId": "instance-a", "sourceRunId": "prior", "sourceName": "Alpha", "sourceOrdinal": 1,
            "targetInstanceId": "instance-b", "targetName": "Beta",
            "createdAt": "2026-09-13T00:00:00Z", "sourceMention": "PRIVATE_SENTINEL",
            "sourceContentHash": "PRIVATE_SENTINEL", "metadata": { "token": "PRIVATE_SENTINEL" },
            "activity": { "runStatus": "running", "updatedAt": "2026-09-13T00:00:00Z", "phase": "runtime_ready" },
        })).unwrap();
        assert_eq!(record.source_run_id, "prior");
        assert_eq!(record.run_id, "successor");
        assert!(record.activity.is_some());
        assert!(
            !serde_json::to_string(&record)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
    }
}
