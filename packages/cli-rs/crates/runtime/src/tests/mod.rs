// Domain-oriented include sections (same module scope via include!).
use super::LocalImageFiles;
use super::attachment_cache;
use super::codex_turn_with_bootstrap;
use super::materialize_local_image_files;
use super::try_begin_daemon_run_report_maintenance;
#[cfg(windows)]
use crate::process_tree;

include!("../../../core/tests/support/process_env.rs");

include!("tests_daemon_session.rs");
include!("tests_daemon_request.rs");
include!("tests_run_loop_resume.rs");
include!("tests_channel_history_cache.rs");
include!("tests_codex_typed_channel_controls.rs");
include!("tests_codex_runtime.rs");
include!("tests_acp_resume.rs");
include!("tests_harness_parameters.rs");
// The fake Claude is a POSIX shell script.
#[cfg(unix)]
include!("tests_claude_stream_cli_turns.rs");
#[cfg(unix)]
include!("tests_claude_stream_subagents.rs");
#[cfg(unix)]
include!("tests_claude_stream_context_exhausted.rs");

fn test_daemon_status_marker() -> super::DaemonRunStatusMarker {
    super::DaemonRunStatusMarker {
        presentation_pending: false,
        task_execution: None,
        operation_failure: None,
        phase: String::new(),
        completed: false,
        delivered: false,
        detail: None,
        model: None,
        effort: None,
        pid: 0,
        updated_at_millis: 0,
        wrapper_exe: None,
        wrapper_args: None,
        wrapper_version: None,
        startup_steps: Vec::new(),
        connection_retry: None,
        wrapper_ready_at_millis: None,
        background_tasks: None,
        wake: None,
    }
}

fn test_agent_record() -> SerializedAgent {
    SerializedAgent {
        id: String::new(),
        instance_id: None,
        user_id: "user-1".to_string(),
        name: String::new(),
        agent_type: String::new(),
        lifetime: None,
        email: String::new(),
        metadata: serde_json::json!({}),
        connected_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
        status: "online".to_string(),
        avatar_url: None,
        runtime_state: None,
        model: None,
        usage: None,
        instances: None,
    }
}

#[cfg(unix)]
fn test_daemon_auth_broker() -> super::DaemonAuthBroker {
    super::DaemonAuthBroker {
        url: "http://127.0.0.1:1".to_string(),
        session_reload_capability: "reload-test".to_string(),
        capabilities: Arc::new(std::sync::Mutex::new(HashMap::new())),
        git_credentials: Arc::new(std::sync::Mutex::new(HashMap::new())),
    }
}

async fn collect_finished_test_children(
    registry: &DaemonRunRegistry,
    timeout: Duration,
    interval: Duration,
) -> Vec<super::DaemonRunExit> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let exits = collect_finished_daemon_children(registry).await;
        if !exits.is_empty() || tokio::time::Instant::now() >= deadline {
            return exits;
        }
        tokio::time::sleep(interval).await;
    }
}

fn test_event_after(
    delay: Duration,
    event: AgentInstanceConnectionEvent,
    failure: &'static str,
) -> tokio::sync::mpsc::UnboundedReceiver<AgentInstanceConnectionEvent> {
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        event_tx.send(event).expect(failure);
    });
    event_rx
}

fn test_empty_daemon_run_child() -> super::DaemonRunChild {
    super::DaemonRunChild {
        #[cfg(windows)]
        handoff: None,
        child: None,
        process_tree: None,
        pid: 0,
        stop_in_progress: false,
        exit_audited: false,
        cwd: None,
        run_id: None,
        execution_key: None,
        instance_id: None,
        resume_session_key: None,
        repo_pool_binding: None,
        agent_id: None,
        agent_name: None,
        auth_capability: None,
        request_capability: None,
        request_context: None,
        status_file_path: None,
        stdout_log_path: None,
        stderr_log_path: None,
        _auth_grant: None,
        _request_grant: None,
    }
}

fn test_empty_persisted_daemon_run() -> super::PersistedDaemonRun {
    let mut run = super::persisted_daemon_run_from_child(&test_empty_daemon_run_child());
    run.profile_id = None;
    run.updated_at = "1".to_string();
    run
}

#[path = "../../../core/tests/support/channel_fixtures.rs"]
mod channel_fixtures;
