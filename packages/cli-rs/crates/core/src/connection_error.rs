//! Hub socket error frames are classified by their structured `failure`, never
//! by their text: the Hub sends public copy only, and `retryable` is its verdict.

use crate::protocol::AgentOperationFailure;

/// The Hub's code for an operation met while it restarts: a Durable Object
/// reset by a deploy, a dropped connection to one, or an overloaded one. The
/// socket it arrived on belongs to the restarting Hub, so the client redials.
pub(crate) const SERVICE_RESTARTING: &str = "service_restarting";

/// Whether an error frame's failure says the Hub is restarting.
pub(crate) fn hub_restarting(failure: Option<&AgentOperationFailure>) -> bool {
    failure.is_some_and(|failure| failure.retryable && failure.code == SERVICE_RESTARTING)
}

/// The `failure` of a raw `{"type":"error", ...}` frame, when it is well formed.
pub(crate) fn frame_failure(frame: &str) -> Option<AgentOperationFailure> {
    let value = serde_json::from_str::<serde_json::Value>(frame).ok()?;
    if value.get("type")?.as_str()? != "error" {
        return None;
    }
    serde_json::from_value(value.get("failure")?.clone()).ok()
}

/// Whether a raw error frame says the Hub is restarting.
pub(crate) fn frame_hub_restarting(frame: &str) -> bool {
    hub_restarting(frame_failure(frame).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_retryable(frame: &str) -> bool {
        frame_failure(frame).is_some_and(|failure| failure.retryable)
    }

    const RESTARTING: &str = r#"{"type":"error","message":"Request failed","failure":{"code":"service_restarting","diagnosticId":"diag_11111111-1111-4111-8111-111111111111","retryable":true,"stage":"runtime.session"}}"#;

    #[test]
    fn only_the_structured_restart_verdict_classifies_a_frame() {
        assert!(frame_hub_restarting(RESTARTING));
        assert!(frame_retryable(RESTARTING));
        // The text a Durable Object reset used to carry decides nothing.
        assert!(!frame_hub_restarting(
            r#"{"type":"error","message":"Durable Object reset because its code was updated."}"#
        ));
        let outage = RESTARTING.replace("service_restarting", "postgres_runtime_unavailable");
        assert!(!frame_hub_restarting(&outage));
        assert!(frame_retryable(&outage));
        let refused = RESTARTING.replace("true", "false");
        assert!(!frame_hub_restarting(&refused));
        assert!(!frame_retryable(&refused));
        assert!(!frame_retryable(
            r#"{"type":"presence","failure":{"retryable":true}}"#
        ));
        assert!(!frame_retryable("not json"));
    }
}
