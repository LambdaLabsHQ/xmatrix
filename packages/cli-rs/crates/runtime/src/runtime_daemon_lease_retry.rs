//! Transient-failure policy for the first command lease renewal.
//!
//! The renewal heartbeat already tolerates a transient failure for
//! `DAEMON_COMMAND_LEASE_RENEW_FAILURE_WINDOW_SECS`, but the synchronous
//! renewal that gates provider launch used to make exactly one attempt. A
//! single packet-level failure at spawn time therefore aborted the launch,
//! while the identical failure moments later was only logged. These helpers
//! give that first renewal the same tolerance without weakening the fence: a
//! lost fence still fails immediately, and only transport-level failures are
//! retried.

use std::time::Duration;

/// Backoff before re-attempting the first renewal, indexed from the failed
/// attempt. `None` ends the schedule, so this bounds the launch at three
/// attempts and under one second of added latency -- far inside the
/// `DAEMON_COMMAND_LEASE_RENEWED_TTL_SECS` lease the renewal is refreshing.
const INITIAL_RENEW_RETRY_BACKOFF_MS: [u64; 2] = [250, 750];

/// A polled command has already committed its physical effect before the Hub
/// completion request is sent. Keep that durable outbox moving across a short
/// Hub/PostgreSQL outage instead of waiting for a later WebSocket reconnect to
/// replay it.
const CONTROL_RESULT_RETRY_BACKOFF_MS: [u64; 4] = [250, 750, 1_500, 2_500];

/// How long to wait before retrying the first renewal after `attempt` failed
/// transiently, or `None` once the bounded schedule is exhausted.
pub(crate) fn initial_renew_retry_delay(attempt: u32) -> Option<Duration> {
    usize::try_from(attempt)
        .ok()
        .and_then(|index| INITIAL_RENEW_RETRY_BACKOFF_MS.get(index))
        .map(|millis| Duration::from_millis(*millis))
}

pub(crate) fn control_result_retry_delay(attempt: u32) -> Option<Duration> {
    usize::try_from(attempt)
        .ok()
        .and_then(|index| CONTROL_RESULT_RETRY_BACKOFF_MS.get(index))
        .map(|millis| Duration::from_millis(*millis))
}

pub(crate) fn control_result_status_is_retryable(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// Socket-path failures that mean "try the HTTP lease endpoint" rather than
/// "this lease is dead". Fence-lost launch errors must not fall back.
pub(crate) fn command_lease_renewal_falls_back_to_http(error: &crate::error::CliError) -> bool {
    error.is_relay_transient()
}

/// What the control socket's answer to a command admission means for the caller.
pub(crate) enum DaemonAdmissionOutcome {
    Admitted,
    /// The socket could not complete the round trip. Admission is the same
    /// Authority `renew` the lease heartbeat performs, so the HTTP lease route
    /// can still admit this command.
    FallBackToHttp(crate::error::CliError),
    /// Authority answered and refused. Retrying the same lease generation would
    /// only be refused again.
    Failed(crate::error::CliError),
}

/// Classify a socket admission so a stalled round trip costs a fallback rather
/// than the command.
///
/// A spawn without a Launch row -- reborn, handoff, management -- cannot use
/// the combined `/command-admit-authorize` preflight, which requires a
/// launchId, so the control socket is its only push-path admission. Dropping
/// the command there leaves no process, no report and a mention that waits
/// forever.
pub(crate) fn classify_socket_command_admission(
    result: crate::error::Result<String>,
) -> DaemonAdmissionOutcome {
    match result {
        Ok(_) => DaemonAdmissionOutcome::Admitted,
        Err(error) if command_lease_renewal_falls_back_to_http(&error) => {
            DaemonAdmissionOutcome::FallBackToHttp(error)
        }
        Err(error) => DaemonAdmissionOutcome::Failed(error),
    }
}

pub(crate) use xmatrix_cli_core::error::describe_error_chain;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_renewal_retries_a_bounded_number_of_times() {
        assert_eq!(
            initial_renew_retry_delay(0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            initial_renew_retry_delay(1),
            Some(Duration::from_millis(750))
        );
        assert_eq!(initial_renew_retry_delay(2), None);
        assert_eq!(initial_renew_retry_delay(u32::MAX), None);
    }

    #[test]
    fn the_retry_schedule_stays_far_inside_the_lease_it_refreshes() {
        let total: u64 = INITIAL_RENEW_RETRY_BACKOFF_MS.iter().sum();
        assert!(
            total < 5_000,
            "retrying must not consume the lease it is refreshing, got {total}ms",
        );
    }

    #[test]
    fn completion_retry_schedule_is_bounded_inside_the_command_lease() {
        assert_eq!(
            control_result_retry_delay(0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            control_result_retry_delay(3),
            Some(Duration::from_millis(2_500))
        );
        assert_eq!(control_result_retry_delay(4), None);
        assert!(CONTROL_RESULT_RETRY_BACKOFF_MS.iter().sum::<u64>() < 10_000);
    }

    #[test]
    fn completion_retries_only_transport_class_http_statuses() {
        assert!(control_result_status_is_retryable(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(control_result_status_is_retryable(
            reqwest::StatusCode::REQUEST_TIMEOUT
        ));
        assert!(control_result_status_is_retryable(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(!control_result_status_is_retryable(
            reqwest::StatusCode::CONFLICT
        ));
        assert!(!control_result_status_is_retryable(
            reqwest::StatusCode::UNAUTHORIZED
        ));
    }

    #[test]
    fn socket_transport_failures_fall_back_to_http() {
        assert!(command_lease_renewal_falls_back_to_http(
            &crate::error::CliError::RelayTransient(
                "Machine Daemon control connection is offline".into()
            ),
        ));
        assert!(command_lease_renewal_falls_back_to_http(
            &crate::error::CliError::RelayTransient(
                "command lease renewal timed out after 10s".into()
            ),
        ));
    }

    #[test]
    fn fence_lost_does_not_fall_back_to_http() {
        assert!(!command_lease_renewal_falls_back_to_http(
            &crate::error::CliError::Launch(
                "Machine Daemon renewal does not own the current live spawn lease generation"
                    .into(),
            ),
        ));
    }

    #[test]
    fn a_stalled_admission_round_trip_falls_back_instead_of_losing_the_command() {
        // The exact failures this daemon logged thousands of times while
        // reborn spawns and their predecessor stops never reached a process.
        for message in [
            "command admission timed out after 10s",
            "Machine Daemon control connection is offline",
            "Machine Daemon command admission was cancelled",
        ] {
            assert!(
                matches!(
                    classify_socket_command_admission(Err(crate::error::CliError::RelayTransient(
                        message.into()
                    ))),
                    DaemonAdmissionOutcome::FallBackToHttp(_),
                ),
                "{message} must fall back to HTTP"
            );
        }
    }

    #[test]
    fn an_answered_refusal_does_not_retry_the_same_lease_generation() {
        assert!(matches!(
            classify_socket_command_admission(Err(crate::error::CliError::Launch(
                "The command lease is stale or no longer held by this Workstation".into(),
            ))),
            DaemonAdmissionOutcome::Failed(_),
        ));
        assert!(matches!(
            classify_socket_command_admission(Ok("2026-09-18T13:00:00Z".into())),
            DaemonAdmissionOutcome::Admitted,
        ));
    }
}
