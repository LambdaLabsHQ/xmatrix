#![deny(warnings)]

// Domain-oriented include sections (same module scope via include!).
// Self-contained helpers use mod; remaining include! peels still share crate-root scope.
include!("runtime_process_utf8.rs");
mod runtime_utf8_shell;
pub use runtime_utf8_shell::maybe_run_utf8_shell;
include!("runtime_harness_cli.rs");
include!("runtime_agent_cli_admission.rs");
mod automation;
mod runtime_unknown_command;
pub use runtime_unknown_command::unknown_command_error;
#[cfg(all(unix, any(target_os = "macos", test)))]
mod runtime_daemon_log_rotation;
#[cfg(target_os = "macos")]
use runtime_daemon_log_rotation::spawn_macos_daemon_log_rotation_task;
#[cfg(any(windows, test))]
mod runtime_broker_proxy_reconnect;
#[cfg(windows)]
mod runtime_windows_run_adoption;
mod runtime_ws_json_reader;
use runtime_ws_json_reader::{
    ProviderInbox, provider_websocket_config, spawn_stdio_json_value_reader,
    spawn_ws_json_value_reader,
};
mod runtime_agent_connection_lifecycle;
use runtime_agent_connection_lifecycle::{
    emit_agent_connection_error_lifecycle, emit_agent_connection_lost_lifecycle,
    emit_agent_connection_reconnected_lifecycle, emit_agent_shutdown_requested_lifecycle,
    next_agent_event_or_termination, send_agent_reconnected_lifecycle,
    try_handle_vendor_connection_lifecycle,
};
mod runtime_run_loop_input;
use runtime_run_loop_input::{
    ChannelControlledRuntime, RunLoopEvents, RunLoopInput, await_turn_with_events,
    reassert_busy_on_reconnect,
};
mod runtime_goal_inbox;
use runtime_goal_inbox::{
    GOAL_INBOX_ENV, bind_goal_inbox_path, bound_goal_inbox_path, cmd_goal,
    publish_bound_goal_state, spawn_goal_inbox_poller,
};
mod runtime_daemon_harness_action;
pub use runtime_daemon_harness_action::{apply_local, local_inventory};
mod runtime_daemon_harness_inventory;
mod runtime_daemon_harness_login;
mod runtime_daemon_harness_policy;
mod runtime_daemon_host;
mod runtime_daemon_idle_sleep;
mod runtime_daemon_lease_retry;
use runtime_daemon_host::{
    DaemonHostControlServer, DaemonHostProfileCommand, ProfileManager, ProfileRuntimeLifecycleState,
};
use runtime_daemon_lease_retry::{
    DaemonAdmissionOutcome, classify_socket_command_admission,
    command_lease_renewal_falls_back_to_http, control_result_retry_delay,
    control_result_status_is_retryable, describe_error_chain, initial_renew_retry_delay,
};
mod runtime_channel_activity;
mod runtime_channel_history_bootstrap;
mod runtime_waiting;
use runtime_channel_activity::{
    ChannelActivityReporter, finish_acp_turn, observe_acp_plan, observe_codex_activity,
};
use runtime_channel_history_bootstrap::with_channel_history_bootstrap;
mod runtime_channel_history_cache;
#[cfg(unix)]
mod runtime_daemon_fd_limit;
mod runtime_daemon_message_send;
mod runtime_daemon_quota_probe;
#[cfg(unix)]
mod runtime_daemon_socket;
mod runtime_execution_outbox;
mod runtime_private_journal;
mod runtime_reply_recovery;
mod runtime_resume_input;
mod runtime_send_authorization;
mod runtime_send_journal;
mod runtime_send_recovery;
mod runtime_send_submission;
mod runtime_session_commands;
#[cfg(windows)]
mod windows_acl;
include!("runtime_management_trust.rs");
include!("runtime_daemon_access_proxy.rs");
include!("runtime_daemon_secret_trace.rs");
include!("runtime_git_branch.rs");
include!("runtime_daemon_command_lease.rs");
include!("runtime_daemon_broker_state.rs");
include!("runtime_daemon_spawn_lifecycle.rs");
include!("runtime_daemon_spawn_state.rs");
include!("runtime_daemon_run_registry.rs");
include!("runtime_daemon_agent_runtime.rs");
include!("runtime_codex_app_session.rs");
include!("runtime_codex_app_transport.rs");
include!("runtime_codex_typed_channel_controls.rs");
include!("runtime_codex_channel_delivery.rs");
mod runtime_agent_goal_status;
mod runtime_claude_messages;
mod runtime_claude_stream_io;
mod runtime_claude_stream_session;
mod runtime_claude_turn;
mod runtime_codex_turn_errors;
mod runtime_connector_mcp;
mod runtime_harness_questions;
mod runtime_headless_runs;
mod runtime_presence_updates;
mod runtime_trusted_role_prompt;
mod runtime_usage_limit;
mod runtime_wake_metrics;
use runtime_agent_goal_status::{
    goal_status_represents_absence, grok_goal_status_from_assistant_text,
    grok_goal_status_from_session_update,
};
use runtime_claude_messages::claude_is_tool_use_block;
use runtime_codex_turn_errors::{
    clear_pending_usage_limit, codex_app_error_is_https_fallback,
    codex_app_error_is_transient_transport, codex_app_error_message,
    codex_auth_failure_requires_exit, codex_reconnect_attempts, codex_reconnect_wait_timeout_error,
    codex_turn_error_message, codex_turn_error_requires_restart,
    codex_turn_error_retryable_before_start, goal_updated_at, report_turn_failure,
    report_turn_failure_with_usage_limit, resend_pending_usage_limit, send_codex_turn_failed_trace,
    zcode_app_error_message, zcode_goal_active_input_id, zcode_goal_state_from_value,
    zcode_is_session_event, zcode_message_id_matches,
};
use runtime_headless_runs::{run_claude_print_external, run_headless_external};
use runtime_presence_updates::{TurnTrace, send_llm_trace, send_llm_trace_with_source};
use runtime_trusted_role_prompt::{
    ImageBlockShape, ensure_runtime_supports_trusted_role, grok_acp_trusted_rules,
    grok_goal_turn_input, prompt_content_blocks, selected_runtime_supports_trusted_role,
    trusted_role_is_active,
};
use xmatrix_harness::fields::{first_f64, first_string};
use xmatrix_harness::quota::claude::{
    claude_named_window_quota_usages, read_claude_oauth_rate_limit_usage,
    record_claude_rate_limit_event,
};
use xmatrix_harness::quota::codex::{codex_wham_quota_usages, read_codex_chatgpt_usage};
use xmatrix_harness::quota::cursor::read_cursor_period_usage;
use xmatrix_harness::quota::grok::{grok_billing_quota_usages, read_grok_build_billing_usage};
use xmatrix_harness::quota::opencode::read_opencode_zen_usage;
use xmatrix_harness::quota::windows::is_rate_limit_snapshot_map;
use xmatrix_harness::quota::zai::{read_zai_coding_plan_quota_usage, zai_monitor_quota_usages};
use xmatrix_harness::usage::has_llm_usage;
include!("runtime_quota_rate_limits.rs");
include!("runtime_external_cli_auth.rs");
include!("runtime_acp_session.rs");
