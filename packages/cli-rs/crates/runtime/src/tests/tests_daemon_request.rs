// Split by test responsibility so request, provider, delivery, and runtime
// regression coverage remain below the source-file remediation target.
include!("tests_daemon_request_fixtures.rs");
include!("tests_daemon_message_send.rs");
include!("tests_runtime_provider_configuration.rs");
include!("tests_channel_delivery_goals.rs");
include!("tests_codex_channel_runtime.rs");
