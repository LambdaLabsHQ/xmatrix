/// Diagnostics this crate prints carry their time once a daemon asks for it
/// (see `daemon_log`); the name shadows the standard macro for every module
/// declared below.
macro_rules! eprintln {
    ($($arg:tt)*) => {
        $crate::daemon_log::eprintln(format_args!($($arg)*))
    };
}

pub mod access;
pub mod agent_instance_connection;
mod agent_instance_delivery;
pub mod agent_registration;
mod agent_runtime_issue;
pub mod agent_trace_read;
pub mod agent_trace_store;
pub mod attachment_cache;
pub mod auth;
pub mod backoff;
pub mod bootstrap;
pub mod bootstrap_prompts;
pub mod channel_read_context;
pub mod config;
mod connection_error;
pub mod daemon_auth;
pub mod daemon_host;
pub mod daemon_log;
pub mod daemon_record;
pub mod error;
pub mod failure_detail;
pub mod fs;
pub mod git_credential;
pub mod hex;
pub mod http;
pub mod human_connection;
pub mod instant;
pub mod local_http_response;
pub mod machine_daemon_connection;
pub mod machine_naming;
pub mod media_cache;
pub mod message_interaction;
pub mod page_assistant_output;
pub mod page_co_write;
pub mod page_media;
pub mod presentation_barrier;
pub mod profile;
pub mod protocol;
pub mod read_through;
pub mod route_key;
pub mod space_ref;
pub mod text_input;
pub mod version;
pub mod websocket;
pub mod wire_compat;

#[cfg(test)]
#[path = "../tests/support/channel_fixtures.rs"]
mod channel_fixtures;
