use super::daemon_control_idle_wait_ms;
use super::daemon_report_terminal_rejection;
use super::run_worktree;
use super::select_headless_wrapper_executable;
use super::{CodexTurnRequest, ImageBlockShape, MachineWorktreeDisposition, prompt_content_blocks};

fn daemon_test_session(token: &str) -> super::config::CliSession {
    super::config::CliSession {
        token: token.to_string(),
        refresh_token: Some(format!("refresh-{token}")),
        user: super::protocol::AuthUser {
            id: "user:test".to_string(),
            email: "test@example.com".to_string(),
            name: Some("Test".to_string()),
        },
        hub_url: "https://xmatrix.test".to_string(),
        relay_url: "wss://xmatrix.test/ws".to_string(),
        updated_at: "100".to_string(),
        expires_at: "1000".to_string(),
    }
}

#[test]
fn connected_session_refreshes_before_the_local_expiry_boundary() {
    let now = 1_000;
    let mut session = daemon_test_session("access");
    session.expires_at = (now + 60).to_string();
    assert_eq!(super::connected_token_refresh_sleep_secs(&session, now), 0);

    session.expires_at = (now + 10 * 60).to_string();
    assert_eq!(
        super::connected_token_refresh_sleep_secs(&session, now),
        5 * 60
    );

    session.expires_at = (now + 60 * 60).to_string();
    assert_eq!(
        super::connected_token_refresh_sleep_secs(&session, now),
        super::CONNECTED_TOKEN_REFRESH_INTERVAL_SECS
    );

    session.refresh_token = None;
    session.expires_at = (now + 60).to_string();
    assert_eq!(super::connected_token_refresh_sleep_secs(&session, now), 60);
}

#[test]
fn daemon_saved_session_reload_rejects_source_rollback() {
    let current = super::DaemonSessionSource {
        hub_url: "https://xmatrix.test".to_string(),
        user_id: "user:test".to_string(),
        updated_at: 100,
        expires_at: 1_000,
        token_digest: "current".to_string(),
    };
    let newer = super::DaemonSessionSource {
        updated_at: 101,
        expires_at: 1_001,
        token_digest: "newer".to_string(),
        ..current.clone()
    };
    let stale = super::DaemonSessionSource {
        updated_at: 99,
        token_digest: "stale".to_string(),
        ..current.clone()
    };
    let shorter = super::DaemonSessionSource {
        updated_at: 101,
        expires_at: 999,
        token_digest: "shorter".to_string(),
        ..current.clone()
    };

    assert!(super::saved_daemon_session_source_is_newer(
        Some(&current),
        &newer
    ));
    assert!(!super::saved_daemon_session_source_is_newer(
        Some(&current),
        &stale
    ));
    assert!(!super::saved_daemon_session_source_is_newer(
        Some(&current),
        &shorter
    ));
}

#[test]
fn stale_daemon_refresh_cannot_overwrite_hot_reloaded_session() {
    let mut state = super::DaemonSessionValue {
        session: daemon_test_session("hot-reloaded"),
        source: None,
        generation: 2,
        saved_session_reload_gate: Arc::new(tokio::sync::Mutex::new(())),
    };

    assert!(!super::install_refreshed_daemon_session_if_current(
        &mut state,
        1,
        daemon_test_session("stale-refresh")
    ));
    assert_eq!(state.session.token, "hot-reloaded");
    assert_eq!(state.generation, 2);
}

#[test]
fn daemon_registry_reconciliation_ignores_timestamps_but_detects_missing_runs() {
    let run = super::PersistedDaemonRun {
        pid: 42,
        run_id: Some("run:test".to_string()),
        execution_key: Some("exec:test".to_string()),
        agent_id: Some("agent:test".to_string()),
        agent_name: Some("codex".to_string()),
        auth_capability: Some("auth-cap".to_string()),
        request_capability: Some("request-cap".to_string()),
        updated_at: "100".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    let mut later = run.clone();
    later.updated_at = "200".to_string();

    assert!(super::persisted_daemon_run_snapshots_match(
        vec![run.clone()],
        vec![later]
    ));
    assert!(!super::persisted_daemon_run_snapshots_match(
        vec![run],
        Vec::new()
    ));
}

#[tokio::test]
async fn daemon_stop_without_a_registry_row_is_idempotently_complete() {
    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    for _ in 0..2 {
        let outcome = super::stop_daemon_child(
            &registry,
            Some("run:ghost"),
            Some("execution:ghost"),
            Some("instance:ghost"),
            None,
            None,
            None,
            None,
            Some(&MachineWorktreeDisposition::Retain),
            None,
            Some("Stop stale Agent Instance"),
        )
        .await
        .expect("a missing local run means there is no process tree left to stop");

        assert_eq!(outcome.0, None);
        assert_eq!(outcome.1, "already_absent");
        assert!(registry.lock().await.is_empty());
    }
}

#[tokio::test]
async fn daemon_stop_checks_supplied_execution_before_touching_the_process() {
    use xmatrix_cli_core::profile::{InstallationRoot, ProfileStore};

    for (registered_execution, requested_execution, should_stop) in [
        (Some("execution:new"), Some("execution:old"), false),
        (None, Some("execution:old"), false),
        (Some("execution:new"), Some("execution:new"), true),
        (Some("execution:new"), None, true),
    ] {
        let root =
            std::env::temp_dir().join(format!("xmatrix-stop-fence-{}", uuid::Uuid::new_v4()));
        let store = ProfileStore::new(InstallationRoot::new(root.clone()));
        let profiles = store.load_or_bootstrap().unwrap();
        let context = store.context_for_default(&profiles).unwrap();
        #[cfg(unix)]
        let mut command = std::process::Command::new("sleep");
        #[cfg(unix)]
        command.arg("60");
        #[cfg(windows)]
        let mut command = std::process::Command::new("ping.exe");
        #[cfg(windows)]
        command.args(["-n", "60", "127.0.0.1"]);
        let mut child = command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::from([(
            super::daemon_run_key("run", "run:reused"),
            super::DaemonRunChild {
                pid,
                run_id: Some("run:reused".into()),
                execution_key: registered_execution.map(str::to_string),
                ..test_empty_daemon_run_child()
            },
        )])));
        let outcome = super::config::scope_profile_context(
            context,
            super::stop_daemon_child(
                &registry,
                Some("run:reused"),
                requested_execution,
                None,
                None,
                None,
                None,
                None,
                Some(&MachineWorktreeDisposition::Retain),
                None,
                Some("scheduled_execution_timeout"),
            ),
        )
        .await;
        let alive = child.try_wait().unwrap().is_none();
        // Always clean up our owned fixture, including on the pre-fix failure.
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&root);
        if should_stop {
            assert!(
                !alive,
                "the matching or legacy stop must still terminate the process: {outcome:?}"
            );
            assert_eq!(outcome.unwrap().1, "process_terminated");
            assert!(registry.lock().await.is_empty());
        } else {
            assert!(alive, "a stale stop terminated the current process");
            let error = outcome.expect_err("a supplied execution fence must match the registry");
            assert!(error.to_string().contains("execution"));
            let rows = registry.lock().await;
            let retained = rows
                .get(&super::daemon_run_key("run", "run:reused"))
                .unwrap();
            assert!(!retained.stop_in_progress);
            assert_eq!(retained.execution_key.as_deref(), registered_execution);
        }
    }
}

#[test]
fn spawn_initial_prompt_overrides_stale_local_prompt() {
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "XMATRIX_AGENT_PROFILE_IDENTITY".to_string(),
        "old instructions".to_string(),
    );
    let env = super::apply_spawn_initial_prompt(env, Some("  registration instructions  "));
    assert_eq!(
        env.get("XMATRIX_AGENT_ROLE_INITIAL_PROMPT")
            .map(String::as_str),
        Some("registration instructions")
    );
    assert!(!env.contains_key("XMATRIX_AGENT_PROFILE_IDENTITY"));
}

#[test]
fn spawn_working_mode_comes_only_from_the_launch() {
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "XMATRIX_AGENT_WORKING_MODE".to_string(),
        "cautious".to_string(),
    );
    // A stale local value never outlives a launch that names no mode.
    let cleared = super::apply_spawn_working_mode(env.clone(), None).unwrap();
    assert!(!cleared.contains_key("XMATRIX_AGENT_WORKING_MODE"));

    let env = super::apply_spawn_working_mode(env, Some("autonomous")).unwrap();
    assert_eq!(
        env.get("XMATRIX_AGENT_WORKING_MODE").map(String::as_str),
        Some("autonomous")
    );

    let error = super::apply_spawn_working_mode(env, Some("reckless")).unwrap_err();
    assert!(error.to_string().contains("reckless"), "{error}");
}

#[test]
fn spawn_space_rules_page_comes_only_from_the_launch() {
    let mut env = std::collections::BTreeMap::new();
    env.insert("XMATRIX_SPACE_RULES_PAGE_ID".to_string(), "stale".to_string());
    let cleared = super::apply_spawn_space_rules(env.clone(), None).unwrap();
    assert!(!cleared.contains_key("XMATRIX_SPACE_RULES_PAGE_ID"));

    let env = super::apply_spawn_space_rules(env, Some("page-1")).unwrap();
    assert_eq!(
        env.get("XMATRIX_SPACE_RULES_PAGE_ID").map(String::as_str),
        Some("page-1")
    );
    assert!(super::apply_spawn_space_rules(env, Some("page-1; rm -rf ~")).is_err());
}

#[test]
fn spawn_env_scrubs_retired_role_values_from_older_state() {
    // A Run resumed from state an older daemon wrote may still carry the
    // retired Role reminder, skills, App requirements, or Role avatar.
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "XMATRIX_AGENT_PROFILE_IDENTITY".to_string(),
        "old instructions".to_string(),
    );
    env.insert(
        "XMATRIX_AGENT_ROLE_INITIAL_PROMPT".to_string(),
        "old initial prompt".to_string(),
    );
    for key in super::RETIRED_ROLE_ENV {
        env.insert(key.to_string(), "stale".to_string());
    }
    let env = super::apply_spawn_initial_prompt(env, None);
    assert!(env.is_empty(), "stale Role env survived: {env:?}");
}

// Only the macOS-gated temp-grant tests use these; keep the imports gated
// too so Linux (which compiles neither) sees no unused imports.
use super::agent_instance_connection::AgentInstanceConnectionClient;
use super::agent_instance_connection::AgentInstanceConnectionEvent;
// The auth-grant rehydration tests spawn `sh`, so they are unix-only.
#[cfg(unix)]
use super::config;
use super::config::CliSession;
use super::error::CliError;
use super::protocol::{
    AgentInstanceServerMessage, AuthUser, ChannelAttachment, ChannelMessage, ChannelReplyContext,
    MessageSender, SerializedAgent,
};
use super::{
    AcpSession, AcpTransportKind, AcpVendorConfig, AgentPresentationAdapter,
    AgentPresentationFacts, AgentRuntimeStateTracker, CodexAppSession, CodexThreadActivity,
    CodexThreadActivityEvent, CodexTransportKind, CodexTransportRecoveryState,
    DAEMON_COMMAND_ADMISSION_REQUEST_TIMEOUT_SECS, DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS,
    DAEMON_COMMAND_LEASE_RENEW_INTERVAL_SECS, DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS,
    DAEMON_COMMAND_LEASE_RENEWED_TTL_SECS, DAEMON_CONTROL_LONG_POLL_WAIT_MS,
    DAEMON_CONTROL_POLL_RETRY_MAX_MS, DAEMON_CONTROL_REQUEST_TIMEOUT_MS, DaemonRequestAgentContext,
    DaemonRoutingWorkspace, DaemonRunChild, DaemonRunRegistry, DaemonRunStatusMarker,
    DaemonSpawnClaim, DaemonSpawnInflight, DaemonSpawnResultParts, GoalCommand,
    HeadlessRuntimeBoundary, InboundChannelMessage, LONG_LIVED_REGISTER_RETRY_MAX,
    PersistedDaemonRun, ZcodeAppSession, acp_args_from_json, acp_backend_matches,
    acp_cancel_notification, acp_initialize_params, acp_message_id_matches,
    acp_model_catalog_from_value, acp_select_permission_option_id, acp_session_new_params,
    agent_presentation_adapter_for_acp_runtime, agent_presentation_adapter_for_runtime,
    agent_type_for_preset_or_runtime, append_windows_utf8_env, WINDOWS_UTF8_CHILD_ENV, apply_spawn_workspace_env,
    cached_attachment_fetch_path, claim_daemon_spawn, claude_stream_boundaries_from_line,
    codex_app_agent_env, codex_app_error_is_transient_transport, codex_app_error_message,
    codex_app_spawn_args, codex_auth_failure_requires_exit, codex_config_model_from_str,
    codex_failure_local_output, codex_goal_dynamic_tools, codex_goal_is_paused,
    codex_goal_set_patch_from_tool_arguments, codex_goal_status_from_app_event,
    codex_goal_status_from_get_response, codex_goal_status_from_response, codex_goal_turn_payload,
    codex_is_primary_output_phase, codex_model_catalog_from_response, codex_paused_goal_notice,
    codex_primary_output_phase, codex_raw_response_delta_text, codex_raw_response_message_text,
    codex_reconnect_attempts, codex_reconnect_wait_timeout, codex_reconnect_wait_timeout_error,
    codex_response_item_id, codex_resume_goal_objective, codex_resume_session_path,
    codex_runtime_trace_payload, codex_runtime_trace_value, codex_turn_error_message,
    codex_turn_error_requires_restart, codex_turn_error_retryable_before_start,
    codex_turn_input_items, codex_turn_start_params, codex_turn_text_with_unavailable_images,
    codex_visible_output, collect_finished_daemon_children, combined_inbound_channel_attachments,
    combined_inbound_channel_prompt, daemon_access_token_from_saved_session,
    daemon_broker_binding_from_values, daemon_managed_workspace_cwd,
    daemon_restart_waits_for_lock_from_env, daemon_run_exit_detail,
    daemon_run_exit_from_status_file, daemon_self_update_timeout, daemon_spawn_claim_key,
    daemon_spawn_cwd_from_values, daemon_spawn_uses_claude_print, daemon_workspace_is_management,
    decode_channel_image_attachment_data_url, default_downstream_kkp_flags,
    drain_pending_inbound_channel_messages, drain_ready_inbound_channel_messages,
    encode_submission_enter, event_requests_active_turn_interrupt, external_registration_cwd,
    extract_llm_usage, finish_agent_disconnect, format_incoming_channel_message,
    format_incoming_channel_message_with_context, format_incoming_channel_message_with_local_paths,
    generic_acp_spawn_args, goal_resume_turn_payload, grok_acp_spawn_args,
    grok_resume_session_path, grok_ws_url_from_banner_line,
    headless_identity_runtime_mismatch_from_values, image_extension_for_mime_type,
    inbound_channel_message_from_event, inbound_delivery_batch_max_messages_from_env,
    is_bounded_retryable_session_register_error, is_claude_code_agent, is_claude_launcher_token,
    is_grok_tool, is_retryable_initial_register_error, is_retryable_relay_operation_error,
    is_zcode_tool, load_codex_resume_session_id, next_daemon_control_poll_retry_delay_ms,
    parse_goal_command, parse_initial_spawn_context,
    persist_daemon_run_status_marker, protocol, read_daemon_run_status_marker, redact_data_urls,
    refresh_daemon_run_status_heartbeat, rehydrate_daemon_run_registry_from_persisted_runs,
    release_daemon_spawn_claim, remove_daemon_run_child, render_initial_message_attachment_lines,
    runtime_accepts_channel_delivery, save_codex_resume_session_id, session_needs_refresh,
    should_publish_codex_runtime_trace, single_message_slash_passthrough,
    slash_command_passthrough, use_claude_print_backend_for, uses_claude_code_runtime,
    validate_codex_app_cwd, write_daemon_run_status_marker_to_path, write_local_image_files,
    zcode_app_error_message, zcode_cancel_notification, zcode_goal_active_input_id,
    zcode_goal_state_from_value, zcode_is_session_event, zcode_message_id_matches,
};
#[cfg(target_os = "macos")]
use super::{
    agent_sandbox_temp_grants, agent_sandbox_temp_grants_from_candidates,
    reject_agent_sandbox_temp_grant,
};
#[cfg(unix)]
use super::{daemon_capability_key, take_daemon_agent_auth_grant};
#[cfg(unix)]
use super::{
    daemon_run_sidecar_path, persist_daemon_run_sidecar,
    recover_daemon_run_registry_from_sidecars_in_dir,
};
use crate::runtime_agent_goal_status::ClaudeTranscriptWatcher;
use crate::runtime_agent_goal_status::claude_goal_status_from_result_text;
use crate::runtime_agent_goal_status::claude_goal_status_from_transcript_line;
use crate::runtime_agent_goal_status::goal_status_represents_absence;
use crate::runtime_claude_messages::claude_assistant_delta_for_message;
use crate::runtime_claude_messages::claude_assistant_text;
use crate::runtime_claude_messages::claude_init_details;
use crate::runtime_claude_messages::claude_message_id;
use crate::runtime_claude_messages::claude_questionnaire_channel_message;
use crate::runtime_claude_messages::claude_runtime_notice_payload;
use crate::runtime_claude_messages::claude_tool_item_key;
use crate::runtime_claude_messages::claude_tool_result_blocks;
use crate::runtime_claude_messages::claude_tool_use_blocks;
use crate::runtime_claude_stream_session::ClaudeSessionControls;
use crate::runtime_claude_stream_session::ClaudeStreamSession;
use crate::runtime_claude_stream_session::ClaudeTurnStatus;
use crate::runtime_claude_turn::claude_apply_effort_control_request;
use crate::runtime_claude_turn::claude_control_response_outcome;
use crate::runtime_claude_turn::claude_effort_catalog;
use crate::runtime_claude_turn::claude_inbound_control_response;
use crate::runtime_claude_turn::claude_initial_effort_from_args;
use crate::runtime_claude_turn::claude_initial_model_from_args;
use crate::runtime_claude_turn::claude_interrupt_control_request;
use crate::runtime_claude_turn::claude_liveness_probe_control_request;
use crate::runtime_claude_turn::claude_model_catalog;
use crate::runtime_claude_turn::claude_result_is_cli_originated;
use crate::runtime_claude_turn::claude_set_model_control_request;
use crate::runtime_claude_turn::claude_transcript_cwd;
use crate::runtime_claude_turn::normalize_cwd_for_compare;
#[cfg(unix)]
use crate::runtime_claude_turn::save_claude_resume_session_id;
use crate::runtime_trusted_role_prompt::claude_goal_turn_input;
use crate::runtime_trusted_role_prompt::claude_stream_extra_args;
use crate::runtime_trusted_role_prompt::claude_stream_user_message;
use crate::runtime_trusted_role_prompt::ensure_runtime_supports_trusted_role;
use crate::runtime_trusted_role_prompt::grok_acp_trusted_rules;
use crate::runtime_trusted_role_prompt::grok_goal_turn_input;
use crate::runtime_trusted_role_prompt::trusted_role_system_prompt;
use base64::Engine as _;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn managed_workspace_leaf(key: &str) -> String {
    daemon_managed_workspace_cwd(key)
        .expect("valid managed workspace key")
        .file_name()
        .expect("leaf")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn daemon_managed_workspace_cwd_is_local_and_key_scoped() {
    let cwd = daemon_managed_workspace_cwd("space-1").expect("valid managed workspace key");
    assert!(cwd.starts_with(dirs::home_dir().expect("home")));
    assert_eq!(
        cwd.parent().and_then(Path::file_name),
        Some(".xmatrix-management".as_ref())
    );

    // Distinct keys stay distinct, and one key always resolves to one directory.
    assert_ne!(
        managed_workspace_leaf("space-1"),
        managed_workspace_leaf("agent-run-1")
    );
    assert_eq!(
        managed_workspace_leaf("space-1"),
        managed_workspace_leaf("space-1")
    );
}

#[test]
fn headless_wrapper_prefers_the_installed_daemon_executable() {
    let current = std::env::current_exe().expect("test executable");
    let fallback = PathBuf::from("missing-exact-process-image");

    assert_eq!(
        select_headless_wrapper_executable(current.clone(), Some(&fallback))
            .expect("installed executable"),
        current
    );
}

#[test]
fn headless_wrapper_uses_the_exact_process_image_after_replacement() {
    let missing =
        std::env::temp_dir().join(format!("xmatrix-replaced-daemon-{}", uuid::Uuid::new_v4()));
    let process_image = std::env::current_exe().expect("test executable");

    assert_eq!(
        select_headless_wrapper_executable(missing, Some(&process_image))
            .expect("exact running process image"),
        process_image
    );
}

#[test]
fn headless_wrapper_fails_closed_when_no_exact_executable_remains() {
    let nonce = uuid::Uuid::new_v4();
    let missing_current = std::env::temp_dir().join(format!("xmatrix-missing-{nonce}"));
    let missing_process = std::env::temp_dir().join(format!("xmatrix-missing-proc-{nonce}"));

    let error = select_headless_wrapper_executable(missing_current, Some(&missing_process))
        .expect_err("missing executable must fail closed");
    assert!(error.to_string().contains("restart the daemon"));
}

#[test]
fn management_run_workspaces_are_isolated_per_run() {
    let first =
        super::daemon_management_run_workspace_cwd("space-1", Some("run-1"), Some("exec-1"))
            .expect("first management Run cwd");
    let same = super::daemon_management_run_workspace_cwd("space-1", Some("run-1"), Some("exec-1"))
        .expect("stable management Run cwd");
    let second =
        super::daemon_management_run_workspace_cwd("space-1", Some("run-2"), Some("exec-2"))
            .expect("second management Run cwd");

    assert_eq!(first, same);
    assert_ne!(first, second);
    assert_eq!(first.parent(), second.parent());
    assert_eq!(
        first
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::len),
        Some(32)
    );
    assert!(super::daemon_management_run_workspace_cwd("space-1", None, Some("exec-1")).is_err());
}

#[test]
fn daemon_grok_runs_disable_shared_leader_processes() {
    assert_eq!(
        super::daemon_isolated_runtime_args("grok", &[]).expect("default Grok args"),
        vec!["--no-leader"]
    );
    assert_eq!(
        super::daemon_isolated_runtime_args(
            "/Users/dev/.grok/bin/grok",
            &["--no-leader".to_string()],
        )
        .expect("explicit isolated Grok args"),
        vec!["--no-leader"]
    );
    assert!(super::daemon_isolated_runtime_args("grok", &["--leader".to_string()]).is_err());
    assert!(
        super::daemon_isolated_runtime_args("codex", &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn acp_mid_turn_abort_is_not_a_successful_completion() {
    let detail = super::acp_turn_cancellation_detail(
        "Grok Build",
        &serde_json::json!({
            "stopReason": "cancelled",
            "cancellation_category": "mid_turn_abort",
        }),
    )
    .expect("cancelled ACP result");
    let turn = super::CodexTurnResult {
        local_output: String::new(),
        restart_after_turn: false,
        failed: true,
        failure_detail: Some(detail),
        usage: None,
        goal: None,
        model: None,
    };
    assert!(super::acp_turn_result_is_cancelled(&turn));
    assert_eq!(
        turn.failure_detail.as_deref(),
        Some("Grok Build ACP turn cancelled: mid_turn_abort")
    );
    assert!(
        super::acp_turn_cancellation_detail(
            "Grok Build",
            &serde_json::json!({ "stopReason": "end_turn" }),
        )
        .is_none()
    );
}

#[test]
fn daemon_managed_workspace_cwd_leaf_is_short_and_portable() {
    // Every Run path is rendered under this leaf, and on Windows the whole
    // path has 260 characters. Composite keys reach ~88 characters, so the leaf
    // is digested to keep paths inside the budget.
    let long_key =
        "2d9154f7-6db1-416c-9bf0-0ae9e11792aa-agent-3633dad6-8f5a-4390-98c1-60a95f541f61-2b875169";
    let leaf = managed_workspace_leaf(long_key);
    assert_eq!(leaf.len(), 32, "leaf={leaf}");
    assert!(
        leaf.chars()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase()),
        "leaf must be lowercase hex: {leaf}"
    );
}

#[test]
fn daemon_managed_workspace_cwd_maps_colons_for_windows_paths() {
    // Historical message:profile keys still resolve; Windows rejects `:` in a
    // path segment, and a hex leaf cannot reintroduce one.
    let leaf = managed_workspace_leaf("msg-id:agent:profile-1");
    assert!(
        !leaf.contains(':'),
        "managed workspace leaf must be Windows-safe: {leaf}"
    );
    assert_ne!(leaf, managed_workspace_leaf("msg-id-agent-profile-1"));
}

#[test]
fn daemon_managed_workspace_cwd_rejects_path_traversal() {
    for value in ["../space", "space/child", "space\\child", " "] {
        assert!(
            daemon_managed_workspace_cwd(value).is_err(),
            "accepted {value:?}"
        );
    }
}

#[test]
fn only_management_workspace_metadata_enables_management_projection() {
    assert!(daemon_workspace_is_management(Some(&serde_json::json!({
        "syntheticManagementWorkspace": true
    }))));
    assert!(!daemon_workspace_is_management(Some(&serde_json::json!({
        "syntheticManagementWorkspace": false
    }))));
    assert!(!daemon_workspace_is_management(Some(&serde_json::json!({
        "syntheticManagementWorkspace": "true"
    }))));
    assert!(!daemon_workspace_is_management(None));
}

fn assert_workspace_spawn_env(
    command: &std::process::Command,
    machine_id: &str,
    cwd: &str,
    name: Option<&str>,
    base_ref: Option<&str>,
) {
    let envs: std::collections::BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(key, value)| Some((key.to_str()?, value?.to_str()?)))
        .collect();
    for (key, expected) in [
        (
            run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV,
            Some(machine_id),
        ),
        (run_worktree::SPAWN_WORKSPACE_CWD_ENV, Some(cwd)),
        (run_worktree::SPAWN_WORKSPACE_NAME_ENV, name),
        (run_worktree::RUN_WORKTREE_BASE_REF_ENV, base_ref),
    ] {
        assert_eq!(envs.get(key).copied(), expected, "{key}");
    }
}

#[test]
fn management_spawn_carries_routing_workspace_without_worktree_metadata() {
    let mut command = std::process::Command::new("xmatrix");
    apply_spawn_workspace_env(
        &mut command,
        Some(DaemonRoutingWorkspace {
            machine_id: "machine-1",
            canonical_cwd: "/tmp/xmatrix-management/space-1/agent-1",
            display_name: "xMatrix management",
        }),
        None,
    );
    assert_workspace_spawn_env(
        &command,
        "machine-1",
        "/tmp/xmatrix-management/space-1/agent-1",
        Some("xMatrix management"),
        None,
    );
}

#[test]
fn in_place_registered_spawn_carries_natural_workspace_and_name_without_base_ref() {
    let mut command = std::process::Command::new("xmatrix");
    // Inherited values must not leak into the child spawn.
    command
        .env(
            run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV,
            "stale-machine",
        )
        .env(run_worktree::SPAWN_WORKSPACE_CWD_ENV, "/stale/path")
        .env(run_worktree::SPAWN_WORKSPACE_NAME_ENV, "stale-name")
        .env(run_worktree::RUN_WORKTREE_BASE_REF_ENV, "stale-ref");
    apply_spawn_workspace_env(
        &mut command,
        Some(DaemonRoutingWorkspace {
            machine_id: "machine-1",
            canonical_cwd: "/work/my-project",
            display_name: "My Project",
        }),
        None,
    );
    assert_workspace_spawn_env(
        &command,
        "machine-1",
        "/work/my-project",
        Some("My Project"),
        None,
    );
}

#[test]
fn materialized_run_worktree_env_keeps_base_ref_even_if_routing_workspace_present() {
    let worktree_env = run_worktree::RunWorktreeSpawnEnv {
        base_machine_id: "machine-base".to_string(),
        base_canonical_cwd: "/work/base".to_string(),
        base_ref: "origin/main".to_string(),
    };
    let mut command = std::process::Command::new("xmatrix");
    // Callers pass routing_workspace=None when materializing, but the env
    // helper still prefers run_worktree_env if both are supplied so a future
    // regression cannot drop XMATRIX_RUN_WORKTREE_BASE_REF.
    apply_spawn_workspace_env(
        &mut command,
        Some(DaemonRoutingWorkspace {
            machine_id: "machine-other",
            canonical_cwd: "/work/other",
            display_name: "Should Not Win",
        }),
        Some(&worktree_env),
    );
    assert_workspace_spawn_env(
        &command,
        "machine-base",
        "/work/base",
        None,
        Some("origin/main"),
    );
}

#[test]
fn grok_resume_session_path_is_stable_for_key() {
    let a = grok_resume_session_path("channel-1");
    let b = grok_resume_session_path("channel-1");
    let c = grok_resume_session_path("channel-2");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.to_string_lossy().contains("grok-resume"));
}

// macOS-only temp-grant allow-roots logic; rejects e.g. /tmp on Linux CI.
#[cfg(target_os = "macos")]
#[test]
fn macos_sandbox_temp_grants_are_narrow_and_deduplicated() {
    let temp_root = fs::canonicalize(std::env::temp_dir()).unwrap();
    let tmp_root = fs::canonicalize("/tmp").unwrap();
    let grants = agent_sandbox_temp_grants_from_candidates([
        temp_root.clone(),
        tmp_root.clone(),
        tmp_root.clone(),
    ])
    .unwrap();

    assert!(grants.rw_dirs.contains(&temp_root));
    assert!(grants.rw_dirs.contains(&tmp_root));
    assert_eq!(
        grants
            .rw_dirs
            .iter()
            .filter(|path| **path == tmp_root)
            .count(),
        1
    );
    for broad in [
        "/",
        "/var",
        "/private",
        "/private/var",
        "/private/var/folders",
        "/private/var/tmp",
        "/opt",
    ] {
        assert!(
            reject_agent_sandbox_temp_grant(Path::new(broad)).is_err(),
            "{broad} should not be accepted as a temp grant"
        );
    }
}

// macOS-only temp-grant allow-roots logic; rejects e.g. /tmp on Linux CI.
#[cfg(target_os = "macos")]
#[test]
fn macos_sandbox_temp_grants_reject_existing_non_temp_dirs() {
    let root = std::env::current_dir()
        .unwrap()
        .join("target")
        .join(format!("xmatrix-sandbox-non-temp-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let result = agent_sandbox_temp_grants_from_candidates([root.clone()]);

    assert!(result.is_err());
    let _ = fs::remove_dir_all(root);
}

// macOS-only temp-grant allow-roots logic; rejects e.g. /tmp on Linux CI.

fn test_serialized_agent(name: &str) -> SerializedAgent {
    SerializedAgent {
        id: format!("agent-{name}"),
        instance_id: Some(format!("inst-{name}")),
        name: name.to_string(),
        agent_type: "codex".to_string(),
        email: format!("{name}@example.com"),
        ..test_agent_record()
    }
}

#[test]
fn codex_app_server_receives_agent_sender_env() {
    let agent = test_serialized_agent("codex");
    let env = codex_app_agent_env(&agent);
    let env: std::collections::HashMap<_, _> = env.into_iter().collect();

    assert_eq!(
        env.get("XMATRIX_AGENT_NAME").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        env.get("XMATRIX_AGENT_ID").map(String::as_str),
        Some("agent-codex")
    );
    assert_eq!(
        env.get("XMATRIX_AGENT_INSTANCE_ID").map(String::as_str),
        Some("inst-codex")
    );
    assert_eq!(
        env.get("XMATRIX_AGENT_SESSION").map(String::as_str),
        Some("1")
    );
}

#[test]
fn initial_register_retry_classifies_network_failures_only() {
    assert!(is_retryable_initial_register_error(&CliError::Relay(
        "WebSocket handshake failed: IO error: Connection reset by peer".into()
    )));
    assert!(is_retryable_initial_register_error(&CliError::Relay(
        "Timed out waiting for registration response".into()
    )));
    assert!(is_retryable_initial_register_error(
        &CliError::RelayTransient("Not connected".into())
    ));
    assert!(is_retryable_initial_register_error(&CliError::Auth(
        "Session refresh failed: error sending request for url".into()
    )));
    assert!(is_retryable_initial_register_error(&CliError::Relay(
        "Machine Daemon credential enrollment failed: error sending request for url".into()
    )));

    assert!(!is_retryable_initial_register_error(&CliError::Relay(
        "Invalid or expired auth token".into()
    )));
    assert!(!is_retryable_initial_register_error(&CliError::Relay(
        "Shutdown requested by server".into()
    )));
    assert!(!is_retryable_initial_register_error(&CliError::Relay(
        "Unexpected first message".into()
    )));
    assert!(!is_retryable_initial_register_error(&CliError::Relay(
        "Agent session request could not be completed".into()
    )));
    assert!(is_bounded_retryable_session_register_error(
        &CliError::Relay("Agent session request could not be completed".into()),
        0
    ));
    assert!(is_bounded_retryable_session_register_error(
        &CliError::Relay("Agent session request could not be completed".into()),
        5
    ));
    assert!(!is_bounded_retryable_session_register_error(
        &CliError::Relay("Agent session request could not be completed".into()),
        6
    ));
    assert!(!is_bounded_retryable_session_register_error(
        &CliError::Relay("Invalid or expired auth token".into()),
        0
    ));
}

#[test]
fn initial_channel_replay_retry_classifies_transient_relay_failures_only() {
    assert!(is_retryable_relay_operation_error(
        &CliError::RelayTransient("Not connected".into())
    ));
    assert!(is_retryable_relay_operation_error(&CliError::Relay(
        "Response channel closed".into()
    )));
    assert!(is_retryable_relay_operation_error(&CliError::Relay(
        "Response timed out after 30000ms".into()
    )));

    assert!(!is_retryable_relay_operation_error(&CliError::Relay(
        "channel access denied".into()
    )));
    assert!(!is_retryable_relay_operation_error(&CliError::Relay(
        "Unexpected channel replay response".into()
    )));
}

#[test]
fn long_lived_register_retry_delay_caps() {
    let mut backoff = super::long_lived_register_backoff();
    for _ in 0..12 {
        let delay = backoff.next_delay();
        assert!(delay <= LONG_LIVED_REGISTER_RETRY_MAX, "{delay:?}");
    }
    assert_eq!(backoff.ceiling(), LONG_LIVED_REGISTER_RETRY_MAX);
}

#[test]
fn initial_register_retries_a_hub_outage_but_not_its_refusal() {
    let hub = |status: u16, retryable: bool| {
        CliError::HttpStatus(Box::new(xmatrix_cli_core::error::HttpStatusError {
            status,
            code: None,
            retryable,
            message: "Machine Daemon credential enrollment failed: xMatrix is restarting; try again"
                .into(),
        }))
    };
    assert!(is_retryable_initial_register_error(&hub(503, true)));
    assert!(!is_retryable_initial_register_error(&hub(503, false)));
    assert!(!is_retryable_initial_register_error(&hub(403, false)));
}

#[test]
fn daemon_control_poll_retry_delay_caps() {
    assert_eq!(next_daemon_control_poll_retry_delay_ms(1_000), 2_000);
    assert_eq!(
        next_daemon_control_poll_retry_delay_ms(DAEMON_CONTROL_POLL_RETRY_MAX_MS),
        DAEMON_CONTROL_POLL_RETRY_MAX_MS
    );
    assert_eq!(
        next_daemon_control_poll_retry_delay_ms(DAEMON_CONTROL_POLL_RETRY_MAX_MS + 1),
        DAEMON_CONTROL_POLL_RETRY_MAX_MS
    );
}

#[test]
fn daemon_control_request_timeout_exceeds_server_wait() {
    const { assert!(DAEMON_CONTROL_REQUEST_TIMEOUT_MS > DAEMON_CONTROL_LONG_POLL_WAIT_MS) };
}

#[test]
fn daemon_control_http_fallback_is_bounded() {
    assert_eq!(super::DAEMON_CONTROL_FALLBACK_BATCH_MAX_COMMANDS, 5);
}

#[test]
fn daemon_effect_is_durable_before_network_admission() {
    let root =
        std::env::temp_dir().join(format!("xmatrix-runtime-effect-{}", uuid::Uuid::new_v4()));
    let path = root.join("effects.json");
    let journal: super::DaemonEffectJournal = std::sync::Arc::new(std::sync::Mutex::new(
        xmatrix_windows_continuity::CommandEffectJournal::new(path.clone()),
    ));
    let command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_stop_agent",
        "requestId": "control-journal-1",
        "relayLease": {
            "leaseOwner": "owner-1",
            "leaseGeneration": 1,
            "entityVersion": 2,
            "daemonEpoch": 3
        }
    }))
    .expect("stop command");
    assert!(matches!(
        super::prepare_command_effect(&journal, &command).expect("durable prepare"),
        super::CommandEffectDispatch::Execute(_)
    ));
    let persisted = std::fs::read_to_string(&path).expect("persisted journal");
    assert!(persisted.contains("admitted"));
    let _ = std::fs::remove_dir_all(root);
}

/// A daemon self-update between receipt and redelivery changes how the same
/// command serializes. The successor must execute a command that never ran,
/// not strand its Run as a conflict (2026-09-27: a summon admitted by 0.16.478
/// and redelivered to 0.16.479 stayed `starting`).
#[test]
fn an_unexecuted_effect_from_an_older_cli_runs_after_the_daemon_update() {
    let root = std::env::temp_dir().join(format!("xmatrix-runtime-rekey-{}", uuid::Uuid::new_v4()));
    let journal: super::DaemonEffectJournal = std::sync::Arc::new(std::sync::Mutex::new(
        xmatrix_windows_continuity::CommandEffectJournal::new(root.join("effects.json")),
    ));
    let command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_stop_agent",
        "requestId": "control-rekey-1",
        "relayLease": {
            "leaseOwner": "owner-1", "leaseGeneration": 1, "entityVersion": 2, "daemonEpoch": 3
        }
    }))
    .expect("stop command");
    let command_type = super::config::active_profile_context()
        .map(|profile| format!("{}:stop", profile.id))
        .unwrap_or_else(|| "stop".to_string());
    for admitted in [false, true] {
        {
            let journal = journal.lock().expect("journal lock");
            let _ = std::fs::remove_file(root.join("effects.json"));
            let effect = journal
                .receive("control-rekey-1", &command_type, &"b".repeat(64))
                .expect("older CLI receive");
            if admitted {
                journal.admit(&effect.stable_id()).expect("older CLI admit");
            }
        }
        assert!(matches!(
            super::prepare_command_effect(&journal, &command).expect("rekeyed prepare"),
            super::CommandEffectDispatch::Execute(_)
        ));
        let effect = journal
            .lock()
            .expect("journal lock")
            .effect_for_control_id("control-rekey-1")
            .expect("journal read")
            .expect("effect kept");
        assert_ne!(effect.payload_digest, "b".repeat(64));
        assert_eq!(
            effect.phase,
            xmatrix_windows_continuity::EffectPhase::Admitted
        );
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn committed_daemon_effect_replay_uses_the_new_claim_lease() {
    let root =
        std::env::temp_dir().join(format!("xmatrix-runtime-replay-{}", uuid::Uuid::new_v4()));
    let journal: super::DaemonEffectJournal = std::sync::Arc::new(std::sync::Mutex::new(
        xmatrix_windows_continuity::CommandEffectJournal::new(root.join("effects.json")),
    ));
    let old_command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_agent",
        "requestId": "control-replay-1",
        "channelId": "channel-1",
        "spaceId": "space-1",
        "workspace": test_daemon_workspace_value(),
        "runtime": "codex", "agentName": "Codex", "prompt": "test",
        "relayLease": {
            "leaseOwner": "owner:old", "leaseGeneration": 2,
            "entityVersion": 3, "daemonEpoch": 229
        }
    }))
    .expect("old spawn command");
    let stable_id = {
        let journal = journal.lock().expect("journal lock");
        let effect = journal
            .receive("control-replay-1", "spawn", &"a".repeat(64))
            .expect("legacy effect receive");
        let stable_id = effect.stable_id();
        journal.admit(&stable_id).expect("legacy effect admit");
        stable_id
    };
    let old_result: super::MachineDaemonReport = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_result",
        "requestId": "control-replay-1",
        "machineId": "machine-1", "canonicalCwd": "/srv/xmatrix",
        "channelId": "channel-1", "agentName": "Codex", "ok": false,
        "error": "connection epoch changed before agent spawn",
        "relayLease": {
            "leaseOwner": "owner:old", "leaseGeneration": 2,
            "entityVersion": 3, "daemonEpoch": 229
        }
    }))
    .expect("old result");
    super::commit_command_effect_result(&journal, &stable_id, &old_result)
        .expect("committed local result");
    let mut new_value = serde_json::to_value(old_command).expect("old command value");
    new_value["relayLease"] = serde_json::json!({
        "leaseOwner": "owner:new", "leaseGeneration": 8,
        "entityVersion": 19, "daemonEpoch": 230
    });
    let new_command = serde_json::from_value(new_value).expect("reclaimed spawn command");
    let (rebound_stable_id, expected_result_digest, rebound) =
        match super::prepare_command_effect(&journal, &new_command).expect("effect replay") {
            super::CommandEffectDispatch::Replay {
                stable_id,
                expected_result_digest,
                report,
                persist_rebind: true,
            } => (stable_id, expected_result_digest, report),
            super::CommandEffectDispatch::Replay {
                persist_rebind: false,
                ..
            } => panic!("unacknowledged completion must persist its rebound envelope"),
            super::CommandEffectDispatch::Execute(_) => panic!("committed effect must replay"),
        };
    let value = serde_json::to_value(rebound).expect("encoded result");
    assert_eq!(value["relayLease"]["leaseOwner"], "owner:new");
    assert_eq!(value["relayLease"]["leaseGeneration"], 8);
    assert_eq!(value["relayLease"]["entityVersion"], 19);
    assert_eq!(value["relayLease"]["daemonEpoch"], 230);
    super::persist_rebound_command_effect_result(
        &journal,
        &rebound_stable_id,
        &expected_result_digest,
        &serde_json::from_value(value.clone()).expect("rebound report"),
    )
    .expect("persist rebound result");
    let persisted = journal
        .lock()
        .expect("journal lock")
        .pending_completion_results()
        .expect("pending result");
    assert_eq!(persisted[0]["relayLease"]["daemonEpoch"], 230);
    let mut conflicting_value = serde_json::to_value(new_command).expect("new command value");
    conflicting_value["channelId"] = serde_json::json!("channel-2");
    let conflicting_command =
        serde_json::from_value(conflicting_value).expect("conflicting command");
    assert!(super::prepare_command_effect(&journal, &conflicting_command).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn successful_effect_replay_requires_fresh_registry_causality() {
    let command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_agent", "requestId": "control-replay-2",
        "channelId": "channel-1",
        "spaceId": "space-1",
        "workspace": test_daemon_workspace_value(),
        "runtime": "codex", "agentName": "Codex", "prompt": "test",
        "relayLease": {"leaseOwner": "owner:new", "leaseGeneration": 4,
            "entityVersion": 9, "daemonEpoch": 12}
    }))
    .expect("spawn command");
    let old_result: super::MachineDaemonReport = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_result", "requestId": "control-replay-2",
        "machineId": "machine-1", "canonicalCwd": "/srv/xmatrix",
        "channelId": "channel-1", "agentName": "Codex", "ok": true,
        "pid": 42, "registryConnectionEpoch": 11, "registrySequence": 7,
        "relayLease": {"leaseOwner": "owner:old", "leaseGeneration": 3,
            "entityVersion": 7, "daemonEpoch": 11}
    }))
    .expect("old result");
    let rebound =
        super::rebind_replayed_command_result(old_result, &command).expect("rebound result");
    let value = serde_json::to_value(rebound).expect("encoded result");
    assert_eq!(value["relayLease"]["daemonEpoch"], 12);
    assert!(value.get("registryConnectionEpoch").is_none());
    assert!(value.get("registrySequence").is_none());
}

#[test]
fn daemon_control_http_admission_carries_exact_launch_and_fence() {
    let payload = super::daemon_command_http_admission_payload(
        super::MachineDaemonReport::MachineCommandAdmitted {
            request_id: "admit:control-1".into(),
            control_id: "control-1".into(),
            launch_id: Some("launch-1".into()),
            channel_id: Some("channel-1".into()),
            admitted_at: Some("2026-09-04T00:00:00Z".into()),
            relay_lease: super::MachineDaemonCommandLease {
                lease_owner: "owner-1".into(),
                lease_generation: 2,
                entity_version: 3,
                daemon_epoch: 4,
            },
        },
    )
    .expect("admission payload");
    assert_eq!(payload["requestId"], "control-1");
    assert_eq!(payload["launchId"], "launch-1");
    assert_eq!(payload["channelId"], "channel-1");
    assert_eq!(payload["admittedAt"], "2026-09-04T00:00:00Z");
    assert_eq!(payload["relayLease"]["leaseGeneration"], 2);
    assert_eq!(payload["relayLease"]["daemonEpoch"], 4);
}

#[test]
fn combined_spawn_admission_carries_only_exact_authority() {
    let command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_agent",
        "requestId": "control-1",
        "launchId": "launch-1",
        "runId": "run-1",
        "instanceId": "instance-1",
        "executionKey": "execution-1",
        "identityId": "instance-1",
        "channelId": "channel-1",
        "spaceId": "space-1",
        "workspace": test_daemon_workspace_value(),
        "registration": {"schemaVersion":1,"key":{"spaceId":"space-1","ownerUserId":"owner-1","machineId":"machine-1","harness":"codex"},
            "runId":"run-1","instanceId":"instance-1","allocationId":"allocation-1","authorizationDigest":"a".repeat(64),
            "environmentVersion":1,"resources":{"workspaces":["workspace-1"],"models":[],"secrets":[],"capabilities":[]}},
        "runtime": "codex", "agentName": "Codex", "prompt": "test",
        "agentBackend": "acp", "agentPresetId": "custom", "agentAcpArgs": ["acp"],
        "requestReviewer": "owner",
        "context": { "requestedModel": "exact-model", "requestedEffort": "high" },
        "relayLease": {
            "leaseOwner": "owner-1", "leaseGeneration": 2,
            "entityVersion": 3, "daemonEpoch": 4
        }
    }))
    .expect("spawn command");
    let intent = super::DaemonSpawnRequest::from_command(command.clone()).expect("spawn intent");
    assert_eq!(intent.requested_model.as_deref(), Some("exact-model"));
    assert_eq!(intent.requested_effort.as_deref(), Some("high"));
    assert_eq!(intent.agent_backend.as_deref(), Some("acp"));
    assert_eq!(intent.agent_preset_id.as_deref(), Some("custom"));
    assert_eq!(intent.agent_acp_args, vec!["acp"]);
    let payload = super::daemon_spawn_admission_payload(&command).expect("combined admission");
    assert!(super::daemon_spawn_has_combined_admission_authority(
        &command
    ));
    assert_eq!(payload["requestId"], "control-1");
    assert_eq!(payload["launchId"], "launch-1");
    assert_eq!(payload["runId"], "run-1");
    assert_eq!(payload["instanceId"], "instance-1");
    assert_eq!(payload["executionKey"], "execution-1");
    assert_eq!(payload["agentId"], "instance-1");
    assert_eq!(payload["spaceId"], "space-1");
    assert_eq!(payload["registration"]["key"]["harness"], "codex");
    assert_eq!(payload["workspace"]["canonicalCwd"], "/srv/xmatrix");
    assert!(
        payload["admittedAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(payload.get("prompt").is_none());
}

#[test]
fn a_spawn_without_a_registration_is_never_admitted_as_a_run() {
    for launch_id in [None, Some("launch-1")] {
        let mut wire = serde_json::json!({
            "type": "machine_spawn_agent",
            "requestId": "control-1",
            "runId": "run-1",
            "instanceId": "instance-1",
            "executionKey": "execution-1",
            "identityId": "instance-1",
            "channelId": "channel-1",
            "spaceId": "space-1",
            "workspace": test_daemon_workspace_value(),
            "runtime": "codex", "agentName": "Codex", "prompt": "test",
            "relayLease": {
                "leaseOwner": "owner-1", "leaseGeneration": 2,
                "entityVersion": 3, "daemonEpoch": 4
            }
        });
        if let Some(launch_id) = launch_id {
            wire["launchId"] = serde_json::json!(launch_id);
        }
        let command: super::MachineDaemonCommand =
            serde_json::from_value(wire).expect("unbound spawn command");
        assert!(!super::daemon_spawn_has_combined_admission_authority(
            &command
        ));
        assert!(super::daemon_spawn_admission_payload(&command).is_err());
        let intent = super::DaemonSpawnRequest::from_command(command).expect("spawn intent");
        assert!(super::resolve_registration_spawn(&intent, "machine-1").is_err());
    }
}

#[test]
fn registered_reborn_spawn_without_a_launch_is_admitted_by_the_lease_preflight() {
    // A reborn successor has a registration binding but no Launch row. Its
    // token route is only a continuation, so skipping this preflight leaves the
    // allocation reserved and every reborn fails as allocation_not_admitted.
    let command: super::MachineDaemonCommand = serde_json::from_value(serde_json::json!({
        "type": "machine_spawn_agent",
        "requestId": "reborn:1-spawn:abc",
        "runId": "channel-1:3#2",
        "instanceId": "channel-1:3",
        "executionKey": "exec:reborn:abc",
        "identityId": "channel-1:3",
        "channelId": "channel-1",
        "spaceId": "space-1",
        "resume": true,
        "workspace": test_daemon_workspace_value(),
        "runtime": "claude", "agentName": "claude", "prompt": "@claude:3:reborn",
        "registration": {
            "schemaVersion": 1,
            "key": {
                "spaceId": "space-1", "ownerUserId": "owner-1",
                "machineId": "machine-1", "harness": "claude"
            },
            "runId": "channel-1:3#2", "instanceId": "channel-1:3",
            "allocationId": "allocation-1",
            "authorizationDigest": "a".repeat(64),
            "environmentVersion": 1,
            "resources": { "workspaces": [], "models": [], "secrets": [], "capabilities": [] }
        },
        "relayLease": {
            "leaseOwner": "owner-1", "leaseGeneration": 2,
            "entityVersion": 3, "daemonEpoch": 4
        }
    }))
    .expect("registered reborn spawn");
    assert!(super::daemon_spawn_has_combined_admission_authority(
        &command
    ));
    let payload = super::daemon_spawn_admission_payload(&command).expect("combined admission");
    assert!(payload.get("launchId").is_none());
    assert_eq!(payload["runId"], "channel-1:3#2");
    assert_eq!(payload["registration"]["allocationId"], "allocation-1");
}

#[test]
fn combined_spawn_admission_distinguishes_terminal_rejection_from_retry() {
    let rejected: super::DaemonSpawnAdmissionResponse = serde_json::from_value(serde_json::json!({
        "ok": false,
        "terminal": true,
        "leaseUntil": "2026-09-05T00:01:00Z",
        "error": "workspace authority changed"
    }))
    .expect("terminal admission response");
    assert!(rejected.terminal);
    assert_eq!(
        rejected.error.as_deref(),
        Some("workspace authority changed")
    );
    assert!(rejected.token.is_none());

    let admitted: super::DaemonSpawnAdmissionResponse = serde_json::from_value(serde_json::json!({
        "ok": true,
        "leaseUntil": "2026-09-05T00:01:00Z",
        "token": "run-token"
    }))
    .expect("successful admission response");
    assert!(admitted.ok);
    assert_eq!(admitted.token.as_deref(), Some("run-token"));
}

#[test]
fn daemon_command_lease_heartbeat_keeps_a_failure_margin() {
    const { assert!(DAEMON_COMMAND_ADMISSION_REQUEST_TIMEOUT_SECS < DAEMON_COMMAND_LEASE_RENEWED_TTL_SECS) };
    const {
        assert!(
            DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS < DAEMON_COMMAND_LEASE_RENEW_INTERVAL_SECS
        );
    }
    const {
        assert!(
            DAEMON_COMMAND_LEASE_RENEW_INTERVAL_SECS + DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS
                < DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS
        );
    }
    const {
        assert!(
            DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS
                + DAEMON_COMMAND_LEASE_RENEW_REQUEST_TIMEOUT_SECS
                < DAEMON_COMMAND_LEASE_RENEWED_TTL_SECS
        );
    }
}

#[tokio::test]
async fn daemon_command_admission_timeout_is_transient_and_bounded() {
    let result = super::with_daemon_command_admission_timeout::<()>(
        "combined spawn admission",
        std::time::Duration::from_millis(1),
        std::future::pending(),
    )
    .await;
    assert!(matches!(
        result,
        Err(CliError::RelayTransient(message))
            if message == "combined spawn admission timed out after 1ms"
    ));
}

#[test]
fn daemon_self_update_timeout_keeps_startup_short() {
    assert_eq!(
        daemon_self_update_timeout("startup"),
        Duration::from_secs(15)
    );
    assert_eq!(
        daemon_self_update_timeout("periodic"),
        Duration::from_secs(120)
    );
}

#[test]
fn headless_daemon_spawn_cwd_prefers_absolute_spawn_env() {
    let absolute = std::env::temp_dir().join("xmatrix-workspace");
    assert_eq!(
        daemon_spawn_cwd_from_values(true, Some(&format!(" {} ", absolute.display()))),
        Some(absolute)
    );
}

#[test]
fn daemon_spawn_cwd_ignores_relative_or_non_headless_values() {
    assert_eq!(
        daemon_spawn_cwd_from_values(true, Some("relative/path")),
        None
    );
    assert_eq!(
        daemon_spawn_cwd_from_values(false, Some("/tmp/xmatrix-workspace")),
        None
    );
}

/// A stale `xmatrix` without a newer subcommand (prod 2026-10-02: `page`
/// inside a grok Run) reads it as a runtime to wrap. It must refuse without
/// touching the parent Run's status file; it used to stamp the live Run
/// `wrapper_startup_failed`.
#[test]
fn nested_unknown_subcommand_leaves_parent_run_status_untouched() {
    use clap::Parser;
    let _guard = test_process_env_lock();
    let root = std::env::temp_dir().join(format!("xmatrix-nested-cmd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let status_path = root.join("run.status.json");
    write_daemon_run_status_marker_to_path(&status_path, "turn_running", false, None);
    let before = std::fs::read(&status_path).unwrap();
    let names = [
        "XMATRIX_HEADLESS",
        "XMATRIX_RUN_ID",
        "XMATRIX_AGENT_IDENTITY_ID_OVERRIDE",
        "XMATRIX_SPAWN_RUNTIME",
        "XMATRIX_RUN_STATUS_FILE",
        "XMATRIX_BIN",
    ];
    let previous = names.map(std::env::var_os);
    let status = status_path.display().to_string();
    let values = [
        "1",
        "run",
        "agent:user:stable",
        "grok",
        status.as_str(),
        "/opt/xmatrix/bin/xmatrix",
    ];
    for (name, value) in names.iter().zip(values) {
        unsafe { std::env::set_var(name, value) };
    }

    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(super::run(xmatrix_cli_args::Cli::parse_from([
            "xmatrix",
            "future-subcommand",
            "read",
        ])));

    for (name, value) in names.iter().zip(previous) {
        match value {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }
    let refusal = result.unwrap_err().to_string();
    assert!(
        refusal.contains("nested xmatrix runtime 'future-subcommand'; expected 'grok'"),
        "{refusal}"
    );
    assert!(
        refusal.contains("/opt/xmatrix/bin/xmatrix future-subcommand"),
        "{refusal}"
    );
    assert_eq!(std::fs::read(&status_path).unwrap(), before);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn headless_identity_runtime_guard_rejects_nested_runtime_mismatch() {
    assert!(headless_identity_runtime_mismatch_from_values(
        true,
        Some("agent:user:stable"),
        "workflow",
        Some("claude")
    ));
    assert!(!headless_identity_runtime_mismatch_from_values(
        true,
        Some("agent:user:stable"),
        "claude",
        Some("claude")
    ));
    assert!(!headless_identity_runtime_mismatch_from_values(
        false,
        Some("agent:user:stable"),
        "workflow",
        Some("claude")
    ));
    assert!(!headless_identity_runtime_mismatch_from_values(
        true,
        None,
        "workflow",
        Some("claude")
    ));
    // A registration that names its runtime by path still matches its own runtime.
    for (tool, expected) in [
        ("codex", "/home/me/.local/bin/codex"),
        ("/home/me/.local/bin/codex", "/home/me/.local/bin/codex"),
        ("codex.exe", "C:\\Users\\me\\.local\\bin\\codex.exe"),
        ("codex", "C:\\tools\\CODEX.EXE"),
    ] {
        assert!(
            !headless_identity_runtime_mismatch_from_values(
                true,
                Some("agent:user:stable"),
                tool,
                Some(expected)
            ),
            "{tool} vs {expected}"
        );
    }
    assert!(headless_identity_runtime_mismatch_from_values(
        true,
        Some("agent:user:stable"),
        "claude",
        Some("/home/me/.local/bin/codex")
    ));
}

#[test]
fn external_registration_cwd_uses_prepared_spawn_cwd_without_current_dir_lookup() {
    let prepared = PathBuf::from("/tmp/xmatrix-prepared-cwd");
    assert_eq!(external_registration_cwd(Some(&prepared)), Some(prepared));
}

#[cfg(unix)]
#[test]
fn detach_daemon_child_process_starts_new_process_group() {
    let mut command = std::process::Command::new("sh");
    command
        .arg("-c")
        .arg("printf '%s %s' $$ $(ps -o pgid= -p $$)")
        .stdout(std::process::Stdio::piped());

    super::detach_daemon_child_process(&mut command);

    let output = command.output().expect("detached child command should run");
    assert!(
        output.status.success(),
        "detached child command failed: {:?}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    let mut parts = stdout.split_whitespace();
    let pid = parts.next().expect("pid").parse::<u32>().expect("pid");
    let pgid = parts.next().expect("pgid").parse::<u32>().expect("pgid");
    assert_eq!(pgid, pid);
}

#[cfg(windows)]
#[test]
fn detached_daemon_child_stays_inside_scheduler_job() {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    assert_eq!(
        super::windows_daemon_child_creation_flags(),
        CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
    );
}

#[test]
fn codex_defaults_to_kkp_enter() {
    assert_ne!(default_downstream_kkp_flags("codex"), 0);
    assert_ne!(default_downstream_kkp_flags("CODEX.EXE"), 0);
}

#[test]
fn non_codex_defaults_to_raw_enter() {
    assert_eq!(default_downstream_kkp_flags("bash"), 0);
    assert_eq!(default_downstream_kkp_flags("claude"), 0);
}

#[test]
fn attachment_fetch_cache_ignores_signed_token_rotation() {
    let first = reqwest::Url::parse(
        "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=one",
    )
    .unwrap();
    let second = reqwest::Url::parse(
        "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=two",
    )
    .unwrap();
    assert_eq!(
        cached_attachment_fetch_path(&first, "png"),
        cached_attachment_fetch_path(&second, "png")
    );
}

#[test]
fn attachment_fetch_accepts_supported_image_mime_types() {
    assert_eq!(image_extension_for_mime_type("image/png"), Some("png"));
    assert_eq!(image_extension_for_mime_type("image/jpeg"), Some("jpg"));
    assert_eq!(image_extension_for_mime_type("image/webp"), Some("webp"));
    assert_eq!(image_extension_for_mime_type("image/gif"), Some("gif"));
    assert_eq!(image_extension_for_mime_type("text/html"), None);
}

#[test]
fn daemon_access_token_ignores_refresh_age() {
    let session = CliSession {
        token: "access-token".to_string(),
        refresh_token: Some("refresh-token".to_string()),
        user: AuthUser {
            id: "user-1".to_string(),
            email: "user@example.com".to_string(),
            name: None,
        },
        hub_url: "https://xmatrix-hub.xmatrix.sh".to_string(),
        relay_url: "wss://xmatrix-hub.xmatrix.sh/ws".to_string(),
        updated_at: "0".to_string(),
        expires_at: "0".to_string(),
    };

    assert!(session_needs_refresh(&session));
    assert_eq!(
        daemon_access_token_from_saved_session(&session),
        "access-token"
    );
}

#[test]
fn daemon_broker_binding_requires_url_and_capability() {
    assert!(daemon_broker_binding_from_values(None, None).is_none());
    assert!(daemon_broker_binding_from_values(Some("http://127.0.0.1:1"), None).is_none());
    for (url, capability) in [
        ("http://127.0.0.1:12345", "capability"),
        ("http://127.0.0.1:23456", "request-capability"),
    ] {
        assert_eq!(
            daemon_broker_binding_from_values(
                Some(&format!(" {url}/ ")),
                Some(&format!(" {capability} "))
            ),
            Some((url.to_string(), capability.to_string()))
        );
    }
}

#[test]
fn daemon_request_clients_rediscover_broker_after_daemon_generation_handoff() {
    // Broker rediscovery lives in the daemon secret/trace peel (include!-scoped).
    let source = [
        include_str!("../lib.rs"),
        include_str!("../runtime_daemon_secret_trace.rs"),
        include_str!("../runtime_daemon_secret_trace_commands.rs"),
        include_str!("../runtime_daemon_connection.rs"),
        include_str!("../runtime_daemon_request_broker.rs"),
        include_str!("../runtime_codex_channel_messages.rs"),
    ]
    .join("\n");
    assert!(source.contains("request_local_daemon_request_json_with_rediscovery"));
    assert!(source.contains("read_daemon_request_broker_state()"));
    assert!(source.contains("rediscovered_daemon_auth_url("));
    assert!(source.contains("/request/rebind-run"));
    assert!(source.contains("/request/handoff-run"));
}

#[test]
fn daemon_reconnect_run_report_maintenance_is_background_and_single_flight() {
    let active = std::sync::atomic::AtomicBool::new(false);
    assert!(try_begin_daemon_run_report_maintenance(&active));
    assert!(!try_begin_daemon_run_report_maintenance(&active));
    active.store(false, std::sync::atomic::Ordering::Release);
    assert!(try_begin_daemon_run_report_maintenance(&active));

    let source = include_str!("../runtime_daemon_connection.rs");
    let reconnected = source
        .split("MachineDaemonConnectionEvent::Reconnected")
        .nth(1)
        .expect("reconnect handler");
    let handler = reconnected
        .split("MachineDaemonConnectionEvent::ShutdownRequested")
        .next()
        .expect("bounded reconnect handler");
    assert!(handler.contains("spawn_daemon_run_report_maintenance("));
    assert!(!handler.contains("report_orphaned_terminal_daemon_runs(&run_registry, &relay).await"));
}

#[test]
fn daemon_run_snapshot_waits_for_control_connection_before_report() {
    let source = include_str!("../runtime_daemon_run_registry.rs");
    let snapshot = source
        .split("async fn report_daemon_run_snapshot(")
        .nth(1)
        .expect("snapshot reporter");
    let body = snapshot
        .split("fn spawn_daemon_child_monitor(")
        .next()
        .expect("bounded snapshot reporter");
    assert!(body.contains("if relay.is_connected()"));
    assert!(body.contains("tokio::time::sleep(Duration::from_millis(100)).await"));
}

/// A Git credential grant is what confines a run to one Space's repository.
/// These pin the two ways that confinement could be lost without anything
/// looking broken: answering a capability that was never issued, and answering
/// for a repository the grant does not name.
mod git_credential_grants {
    use super::super::{DaemonGitCredentialGrantState, resolve_git_credential_grant};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn grants(
        entries: &[(&str, &str, &str)],
    ) -> Arc<Mutex<HashMap<String, DaemonGitCredentialGrantState>>> {
        let mut table = HashMap::new();
        for (capability, channel_id, repository) in entries {
            table.insert(
                (*capability).to_string(),
                DaemonGitCredentialGrantState {
                    channel_id: (*channel_id).to_string(),
                    run_id: format!("run-{capability}"),
                    execution_key: format!("exec-{capability}"),
                    repository: (*repository).to_string(),
                },
            );
        }
        Arc::new(Mutex::new(table))
    }

    #[test]
    fn a_grant_answers_for_the_repository_it_names() {
        let table = grants(&[("cap-a", "channel-a", "LambdaLabsHQ/xmatrix")]);
        let grant = resolve_git_credential_grant(&table, "cap-a", "LambdaLabsHQ/xmatrix")
            .expect("the granted repository resolves");
        assert_eq!(grant.channel_id, "channel-a");
        assert_eq!(grant.repository, "LambdaLabsHQ/xmatrix");
    }

    #[test]
    fn a_grant_does_not_answer_for_another_repository() {
        let table = grants(&[("cap-a", "channel-a", "LambdaLabsHQ/xmatrix")]);
        assert_eq!(
            resolve_git_credential_grant(&table, "cap-a", "LambdaLabsHQ/other"),
            None,
            "a repository outside the grant must be refused, never widened to the installation"
        );
    }

    #[test]
    fn one_runs_capability_cannot_reach_another_runs_repository() {
        // Two Spaces on one machine. This is the case the whole path exists for:
        // both capabilities are valid, and each must stay on its own side.
        let table = grants(&[
            ("cap-a", "channel-a", "SpaceA/service"),
            ("cap-b", "channel-b", "SpaceB/service"),
        ]);
        assert_eq!(
            resolve_git_credential_grant(&table, "cap-a", "SpaceB/service"),
            None
        );
        assert_eq!(
            resolve_git_credential_grant(&table, "cap-b", "SpaceA/service"),
            None
        );
        assert!(resolve_git_credential_grant(&table, "cap-a", "SpaceA/service").is_some());
        assert!(resolve_git_credential_grant(&table, "cap-b", "SpaceB/service").is_some());
    }

    #[test]
    fn the_repository_matches_however_the_remote_url_spells_it() {
        // The pool stores a lowercased canonical identity; Git reports the path
        // exactly as the remote is written. Comparing byte-for-byte would refuse
        // the run its own repository.
        let table = grants(&[("cap-a", "channel-a", "lambdalabshq/xmatrix")]);
        assert!(resolve_git_credential_grant(&table, "cap-a", "LambdaLabsHQ/xmatrix").is_some());
        assert!(resolve_git_credential_grant(&table, "cap-a", "lambdalabshq/XMATRIX").is_some());
        assert_eq!(
            resolve_git_credential_grant(&table, "cap-a", "lambdalabshq/xmatrix-other"),
            None,
            "case-insensitive must not mean prefix-tolerant"
        );
    }

    #[test]
    fn a_capability_that_was_never_issued_resolves_to_nothing() {
        let table = grants(&[("cap-a", "channel-a", "LambdaLabsHQ/xmatrix")]);
        assert_eq!(
            resolve_git_credential_grant(&table, "cap-unknown", "LambdaLabsHQ/xmatrix"),
            None
        );
    }

    #[test]
    fn resolving_leaves_the_grant_in_place_for_the_next_git_command() {
        // Unlike the one-shot agent auth capability, Git asks again on every
        // fetch and push for the life of the run.
        let table = grants(&[("cap-a", "channel-a", "LambdaLabsHQ/xmatrix")]);
        for _ in 0..3 {
            assert!(
                resolve_git_credential_grant(&table, "cap-a", "LambdaLabsHQ/xmatrix").is_some()
            );
        }
    }
}

/// Which repositories a pool identity may be spoken for. Anything that is not
/// exactly a GitHub repository has no connector behind it, so it must resolve to
/// nothing rather than to a guess.
mod git_credential_pool_identity {
    use super::super::github_repository_of_pool_identity;

    #[test]
    fn a_github_identity_yields_its_owner_and_repository() {
        assert_eq!(
            github_repository_of_pool_identity("github.com/lambdalabshq/xmatrix").as_deref(),
            Some("lambdalabshq/xmatrix")
        );
    }

    #[test]
    fn identities_that_are_not_a_github_repository_yield_nothing() {
        for identity in [
            "gitlab.com/lambdalabshq/xmatrix",
            "github.com/lambdalabshq",
            "github.com/lambdalabshq/xmatrix/extra",
            "github.com/",
            "ssh://github.com/lambdalabshq/xmatrix",
            "",
        ] {
            assert_eq!(
                github_repository_of_pool_identity(identity),
                None,
                "{identity:?} must not resolve to a repository"
            );
        }
    }
}

/// Grants must not outlive the run they were issued for.
mod git_credential_revocation {
    use super::super::{
        DaemonGitCredentialGrantState, issue_git_credential_grant, resolve_git_credential_grant,
        revoke_git_credential_grants_for_run,
    };
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn state(run_id: &str, repository: &str) -> DaemonGitCredentialGrantState {
        DaemonGitCredentialGrantState {
            channel_id: "channel-a".to_string(),
            run_id: run_id.to_string(),
            execution_key: format!("exec-{run_id}"),
            repository: repository.to_string(),
        }
    }

    #[test]
    fn ending_a_run_takes_its_capability_with_it() {
        let grants = Arc::new(Mutex::new(HashMap::new()));
        let capability = issue_git_credential_grant(&grants, state("run-1", "org/repo"))
            .expect("a grant is issued");
        assert!(resolve_git_credential_grant(&grants, &capability, "org/repo").is_some());

        revoke_git_credential_grants_for_run(&grants, "run-1", "exec-run-1");

        assert_eq!(
            resolve_git_credential_grant(&grants, &capability, "org/repo"),
            None,
            "a capability that outlived its run would still work from a stale process"
        );
    }

    #[test]
    fn ending_one_run_leaves_the_others_alone() {
        let grants = Arc::new(Mutex::new(HashMap::new()));
        let first = issue_git_credential_grant(&grants, state("run-1", "org/repo")).unwrap();
        let second = issue_git_credential_grant(&grants, state("run-2", "org/repo")).unwrap();

        revoke_git_credential_grants_for_run(&grants, "run-1", "exec-run-1");

        assert_eq!(
            resolve_git_credential_grant(&grants, &first, "org/repo"),
            None
        );
        assert!(resolve_git_credential_grant(&grants, &second, "org/repo").is_some());
    }
}

#[test]
fn structured_registration_rejections_override_text_retry_heuristics() {
    for retryable in [false, true] {
        let error: CliError = xmatrix_cli_core::error::AgentOperationError {
            message: "Agent session request could not be completed; timed out".into(),
            failure: protocol::AgentOperationFailure {
                code: if retryable {
                    "postgres_runtime_unavailable"
                } else {
                    "agent_run_forbidden"
                }
                .into(),
                stage: "relay.authenticate".into(),
                origin_stage: None,
                diagnostic_id: "diag_11111111-1111-4111-8111-111111111111".into(),
                retryable,
            },
        }
        .into();
        assert_eq!(is_retryable_initial_register_error(&error), retryable);
        assert_eq!(super::is_retryable_relay_operation_error(&error), retryable);
        assert!(!is_bounded_retryable_session_register_error(&error, 0));
    }
}

#[test]
fn terminal_report_rejection_survives_the_hub_rewriting_the_authority_code() {
    // Authority's own codes.
    assert!(daemon_report_terminal_rejection(&CliError::Relay(
        "Machine Daemon report failed: run_not_found".into()
    )));
    assert!(daemon_report_terminal_rejection(&CliError::Relay(
        "Machine Daemon report run is not owned by this principal".into()
    )));
    // What the daemon actually receives once the Hub replaces an unrecognised
    // code with its generic one. Recognising this is the difference between
    // dropping a dead run and re-sending its exit forever.
    assert!(daemon_report_terminal_rejection(&CliError::Http(
        "The Workstation request could not be processed. \
         (code=runtime.authority_rejected, retryable=false, status=404)"
            .into()
    )));
}

#[test]
fn a_report_that_could_still_succeed_is_never_treated_as_terminal() {
    // Retryable, so the run is still ours and the report must be re-sent.
    assert!(!daemon_report_terminal_rejection(&CliError::Http(
        "The Workstation request could not be processed. \
         (code=runtime.authority_rejected, retryable=true, status=503)"
            .into()
    )));
    // Non-retryable, but not a missing run: an authorization change must not
    // silently discard the exit of a run that still exists.
    assert!(!daemon_report_terminal_rejection(&CliError::Http(
        "The Workstation request could not be processed. \
         (code=runtime.authority_rejected, retryable=false, status=403)"
            .into()
    )));
    assert!(!daemon_report_terminal_rejection(&CliError::Http(
        "error sending request: client error (Connect): tls handshake eof".into()
    )));
    assert!(!daemon_report_terminal_rejection(&CliError::Relay(
        "Timed out awaiting terminal Run finalization".into()
    )));
}

#[test]
fn a_run_sidecar_written_before_space_id_existed_still_loads() {
    // Sidecars persisted before the field was added carry no `spaceId`. serde
    // rejects the whole record for one missing field, and the daemon that
    // cannot load a record cannot report that run's exit at all.
    let legacy = serde_json::json!({
        "agentName": "claude-legend",
        "channelId": "channel-1",
        "workspaceCwd": "/tmp/slot",
        "requestReviewer": "owner",
    });
    let context: DaemonRequestAgentContext =
        serde_json::from_value(legacy).expect("a spaceId-less sidecar must still load");
    assert_eq!(context.space_id, "");
    assert_eq!(context.agent_name, "claude-legend");

    let current = serde_json::json!({
        "agentName": "claude-legend",
        "spaceId": "space-7",
        "channelId": "channel-1",
        "workspaceCwd": "/tmp/slot",
        "requestReviewer": "owner",
        "sandboxed": false,
    });
    let context: DaemonRequestAgentContext =
        serde_json::from_value(current).expect("a current sidecar must load unchanged");
    assert_eq!(context.space_id, "space-7");
}

#[test]
fn registration_spawn_uses_the_hub_registration_preset_and_bound_model() {
    let wire = serde_json::json!({
        "type":"machine_spawn_agent", "requestId":"command", "spaceId":"space", "channelId":"channel",
        "runId":"run", "instanceId":"instance", "identityId":"instance", "runtime":"/opt/codex/bin/codex", "runtimeArgs":["hub-argument"],
        "sandboxMode":"workspace-write", "requestReviewer":"owner",
        "harness":{"id":"codex","runtime":"codex","agentType":"codex","backend":"codex-app","defaultArgs":[],
            "acpArgs":["acp"],"launcherNames":["codex"],"classicConfigDirs":["~/.codex"]},
        "agentName":"Display label", "prompt":"task", "context":{"requestedModel":"unapproved-model"},
        "workspace":{"ownerUserId":"owner","machineId":"machine","hostId":"host","canonicalCwd":"/repo",
            "displayName":"Repo","visibility":"private","createdAt":"now","updatedAt":"now","lastSeenAt":"now"},
        "registration":{"schemaVersion":1,"key":{"spaceId":"space","ownerUserId":"owner","machineId":"machine","harness":"codex"},
            "runId":"run","instanceId":"instance","allocationId":"allocation","authorizationDigest":"a".repeat(64),
            "environmentVersion":1,"runtimeModel":"provider/model",
            "resources":{"workspaces":["workspace"],"models":["model"],"secrets":[],"capabilities":[]}}
    });
    let command = serde_json::from_value(wire.clone()).unwrap();
    let intent = super::DaemonSpawnRequest::from_command(command).unwrap();
    let resolved = super::resolve_registration_spawn(&intent, "machine").unwrap();
    // The Hub maintains the registration: its launch settings are the ones used.
    assert_eq!(resolved.runtime, "/opt/codex/bin/codex");
    assert_eq!(resolved.runtime_args, ["hub-argument"]);
    assert_eq!(resolved.agent_backend.as_deref(), Some("codex-app"));
    assert_eq!(resolved.agent_preset_id.as_deref(), Some("codex"));
    assert_eq!(resolved.agent_acp_args, ["acp"]);
    assert_eq!(resolved.requested_model.as_deref(), Some("provider/model"));
    // A cold runtime has no provider model observation. The admitted logical
    // model must not be turned into a command-line/ACP override.
    let mut defaults = wire.clone();
    defaults["context"] = serde_json::json!({"requestedEffort":"high"});
    let defaults =
        super::DaemonSpawnRequest::from_command(serde_json::from_value(defaults).unwrap()).unwrap();
    let defaults = super::resolve_registration_spawn(&defaults, "machine").unwrap();
    assert_eq!(defaults.requested_model, None);
    assert_eq!(defaults.requested_effort, None);
    assert!(super::resolve_registration_spawn(&intent, "other-machine").is_err());
    // Every Run is a Run of a registration: an unbound spawn is refused.
    let mut unbound = wire.clone();
    unbound.as_object_mut().unwrap().remove("registration");
    assert_rejected_registration_spawn(unbound);
    // An older Hub may still send the retired Role fields; they are ignored
    // and the registered launch still resolves.
    let mut role = wire.clone();
    role["roleAppRequirements"] = serde_json::json!([{"providerId":"github","scopes":["repo"]}]);
    role["roleReminder"] = serde_json::json!("stay in role");
    role["agentAvatarUrl"] = serde_json::json!("role.svg");
    let role =
        super::DaemonSpawnRequest::from_command(serde_json::from_value(role).unwrap()).unwrap();
    assert!(super::resolve_registration_spawn(&role, "machine").is_ok());
    let mut no_preset = wire.clone();
    no_preset.as_object_mut().unwrap().remove("harness");
    assert_rejected_registration_spawn(no_preset);
    let mut other_preset = wire.clone();
    other_preset["harness"]["id"] = serde_json::json!("claude");
    assert_rejected_registration_spawn(other_preset);
    for (field, value) in [
        ("identityId", serde_json::json!("legacy-profile")),
        ("managementSpaceId", serde_json::json!("other-space")),
        ("remoteRepo", serde_json::json!("other/repository")),
        ("runWorktree", serde_json::json!(true)),
    ] {
        let mut changed = wire.clone();
        changed[field] = value;
        assert_rejected_registration_spawn(changed);
    }
    let mut repo = wire.clone();
    repo["registration"]["resources"]["workspaces"] = serde_json::json!(["repo:owner/project"]);
    repo["remoteRepo"] = serde_json::json!("owner/project");
    repo["runWorktree"] = serde_json::json!(true);
    repo["workspace"]["managedKey"] = serde_json::json!("registered-repo");
    let repo_intent =
        super::DaemonSpawnRequest::from_command(serde_json::from_value(repo.clone()).unwrap())
            .unwrap();
    assert!(super::resolve_registration_spawn(&repo_intent, "machine").is_ok());
    repo["remoteRepo"] = serde_json::json!("other/project");
    assert_rejected_registration_spawn(repo);
    // No workspace reference: a private managed directory for a management Run.
    let mut managed = wire.clone();
    managed["registration"]["resources"]["workspaces"] = serde_json::json!([]);
    managed["managementSpaceId"] = serde_json::json!("space");
    managed["workspace"]["managedKey"] = serde_json::json!("registration-managed");
    managed["workspace"]["canonicalCwd"] =
        serde_json::json!(".xmatrix-management/registration-managed");
    let managed_intent =
        super::DaemonSpawnRequest::from_command(serde_json::from_value(managed.clone()).unwrap())
            .unwrap();
    assert!(super::resolve_registration_spawn(&managed_intent, "machine").is_ok());
    for (field, value) in [
        ("remoteRepo", serde_json::json!("owner/project")),
        ("runWorktree", serde_json::json!(true)),
    ] {
        let mut changed = managed.clone();
        changed[field] = value;
        assert_rejected_registration_spawn(changed);
    }
    let mut unplaced = managed.clone();
    unplaced["workspace"]
        .as_object_mut()
        .unwrap()
        .remove("managedKey");
    assert_rejected_registration_spawn(unplaced);
    let mut unmanaged = managed;
    unmanaged
        .as_object_mut()
        .unwrap()
        .remove("managementSpaceId");
    assert_rejected_registration_spawn(unmanaged);
    let mut wrong_owner = wire;
    wrong_owner["registration"]["key"]["ownerUserId"] = serde_json::json!("other-owner");
    assert_rejected_registration_spawn(wrong_owner);
}

/// A Claude reborn whose spawn cwd does not own its session is refused by the
/// daemon before any process starts (prod 2026-09-24: the refusal only surfaced
/// after three refused turns and a 30s wrapper timeout). The refusal names the
/// directory the session belongs to and the current launch syntax, not `:new`.
#[test]
fn claude_reborn_in_a_foreign_cwd_is_refused_before_spawn() {
    let _guard = test_process_env_lock();
    let root =
        std::env::temp_dir().join(format!("xmatrix-reborn-preflight-{}", uuid::Uuid::new_v4()));
    let (config_dir, claude_dir) = (root.join("xmatrix-config"), root.join("claude-config"));
    let (slot, fresh) = (root.join("slot"), root.join("run-fresh"));
    let transcripts = claude_dir.join("projects").join("slot-project");
    for dir in [&config_dir, &slot, &fresh, &transcripts] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let previous = ["XMATRIX_CONFIG_DIR", "CLAUDE_CONFIG_DIR"].map(|name| std::env::var(name).ok());
    unsafe {
        std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);
    }
    let transcript = transcripts.join("sess-slot.jsonl");
    std::fs::write(
        &transcript,
        serde_json::json!({ "cwd": slot.to_string_lossy() }).to_string(),
    )
    .unwrap();
    crate::runtime_claude_turn::save_claude_resume_session_id(
        Some("reborn-key"),
        Some("sess-slot"),
    )
    .unwrap();
    let intent = |runtime: &str, resume: bool| {
        let wire = serde_json::json!({
            "type":"machine_spawn_agent", "requestId":"command", "spaceId":"space", "channelId":"channel",
            "runId":"run", "instanceId":"instance", "runtime":runtime, "agentName":"claude", "prompt":"task",
            "resume":resume, "resumeSessionKey":"reborn-key",
            "workspace":{"ownerUserId":"owner","machineId":"machine","hostId":"host","canonicalCwd":"/repo",
                "displayName":"Repo","visibility":"private","createdAt":"now","updatedAt":"now","lastSeenAt":"now"}
        });
        super::DaemonSpawnRequest::from_command(serde_json::from_value(wire).unwrap()).unwrap()
    };
    let reborn = intent("claude", true);

    assert!(super::daemon_claude_reborn_cwd_preflight(&reborn, &slot).is_ok());
    let refusal = super::daemon_claude_reborn_cwd_preflight(&reborn, &fresh)
        .unwrap_err()
        .to_string();
    assert!(refusal.contains("Refusing to reborn"), "{refusal}");
    assert!(refusal.contains(&*slot.to_string_lossy()), "{refusal}");
    assert!(
        refusal.contains("@claude repo:") && !refusal.contains("`:new`"),
        "{refusal}"
    );
    // Not a reborn, or not Claude: the preflight has nothing to say.
    assert!(super::daemon_claude_reborn_cwd_preflight(&intent("claude", false), &fresh).is_ok());
    assert!(super::daemon_claude_reborn_cwd_preflight(&intent("codex", true), &fresh).is_ok());
    // The transcript is gone: refused, not resumed blind.
    std::fs::remove_file(&transcript).unwrap();
    let missing = super::daemon_claude_reborn_cwd_preflight(&reborn, &slot)
        .unwrap_err()
        .to_string();
    assert!(
        missing.contains("no Claude transcript") && missing.contains("@claude repo:"),
        "{missing}"
    );

    for (name, value) in ["XMATRIX_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]
        .into_iter()
        .zip(previous)
    {
        match value {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reconnect_replays_only_completions_leased_by_the_live_connection() {
    let leased_at = |epoch: u64| {
        serde_json::json!({
            "type": "machine_spawn_result",
            "requestId": "control:1",
            "relayLease": { "daemonEpoch": epoch, "leaseGeneration": 2 },
        })
    };
    let live = |epoch: u64| epoch == 67;
    assert!(super::completion_lease_is_current(&leased_at(67), live));
    assert!(
        !super::completion_lease_is_current(&leased_at(66), live),
        "Hub refuses a lease from an earlier connection on every resend"
    );
    assert!(super::completion_lease_is_current(
        &serde_json::json!({ "type": "machine_stop_result", "requestId": "control:2" }),
        live
    ));
}

#[tokio::test(start_paused = true)]
async fn a_self_update_handoff_waits_for_spawns_already_received() {
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let guard = super::SpawnCommandInFlight::enter(&counter);
    let started = tokio::time::Instant::now();
    let release = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        drop(guard);
    });
    super::wait_for_spawn_commands_before_handoff(&counter).await;
    assert!(started.elapsed() >= std::time::Duration::from_secs(5));
    assert!(started.elapsed() < std::time::Duration::from_secs(6));
    release.await.unwrap();

    // A spawn that never finishes cannot pin the old daemon.
    let _stuck = super::SpawnCommandInFlight::enter(&counter);
    let started = tokio::time::Instant::now();
    super::wait_for_spawn_commands_before_handoff(&counter).await;
    assert!(started.elapsed() >= super::SPAWN_HANDOFF_WAIT);
}

#[tokio::test]
async fn linked_page_reads_use_the_authorized_channel_route_without_a_mirror() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    for (status, body, expected_ok) in [
        ("200 OK", r#"{"pages":[]}"#, true),
        ("403 Forbidden", r#"{"error":"forbidden"}"#, false),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = super::read_daemon_local_http_request(&mut stream)
                .await
                .unwrap();
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/api/channels/channel-id/pages");
            assert_eq!(request.headers["authorization"], "Bearer run-token");
            super::write_daemon_auth_broker_response(&mut stream, status, body).await;
        });
        let result = super::cmd_page(
            &hub,
            "run-token",
            xmatrix_cli_args::PageCommand::Linked {
                conversation: Some("channel-id".into()),
            },
        )
        .await;
        assert_eq!(result.is_ok(), expected_ok);
        server.await.unwrap();
    }
}

#[test]
fn daemon_stop_results_preserve_exact_command_identity_and_failure_pid() {
    let command = serde_json::json!({
        "type":"machine_stop_agent", "requestId":"stop-request", "runId":"stop-run",
        "executionKey":"stop-execution", "agentId":"stop-agent", "instanceId":"stop-instance",
        "resumeSessionKey":"stop-session", "repoIdentity":"github:owner/repo", "repoKeyId":"stop-repo-key",
        "slotId":"stop-slot", "worktreeDisposition":"retain", "pid":42, "reason":"stop now",
    });
    for succeeded in [true, false] {
        let request = super::DaemonStopRequest::from_command(
            serde_json::from_value(command.clone()).unwrap(),
        )
        .unwrap();
        let result = if succeeded {
            Ok((Some(43), "already_absent"))
        } else {
            Err(super::CliError::Launch("stop failed".into()))
        };
        let report = serde_json::to_value(request.into_report(result, None)).unwrap();
        for key in [
            "requestId",
            "runId",
            "executionKey",
            "agentId",
            "instanceId",
            "resumeSessionKey",
            "repoIdentity",
            "repoKeyId",
            "slotId",
            "worktreeDisposition",
        ] {
            assert_eq!(report[key], command[key], "stop report changed {key}");
        }
        assert_eq!(report["ok"], serde_json::json!(succeeded));
        assert_eq!(report["pid"], if succeeded { 43 } else { 42 });
        if succeeded {
            assert_eq!(report["cleanupReason"], "already_absent");
            assert!(report.get("error").is_none());
        } else {
            assert!(report["error"].as_str().unwrap().contains("stop failed"));
            assert!(report.get("cleanupReason").is_none());
        }
    }
}

fn assert_rejected_registration_spawn(value: serde_json::Value) {
    let intent =
        super::DaemonSpawnRequest::from_command(serde_json::from_value(value).unwrap()).unwrap();
    assert!(super::resolve_registration_spawn(&intent, "machine").is_err());
}
