use super::*;

#[test]
fn catalog_timeout_names_the_failed_boundary() {
    for boundary in [
        "directory",
        "authority_page",
        "revision_probe",
        "projection",
        "runtime_presence",
    ] {
        let body = serde_json::json!({
            "error": "Channel catalog is temporarily unavailable",
            "code": "channel_catalog_timeout",
            "retryable": true,
            "boundary": boundary,
        });
        let error =
            response_status_error(reqwest::StatusCode::SERVICE_UNAVAILABLE, &body.to_string());
        assert!(matches!(error.http_message(), Some(detail)
            if detail == format!("Channel catalog is temporarily unavailable (boundary: {boundary})")));
    }
}

#[test]
fn unknown_or_missing_boundary_is_not_rendered() {
    for boundary in [
        serde_json::Value::Null,
        serde_json::json!("none"),
        serde_json::json!("future_stage"),
        serde_json::json!("private-provider-value\nsecond line"),
        serde_json::json!({"secret": "private-provider-value"}),
    ] {
        let body = serde_json::json!({
            "error": "unavailable",
            "code": "channel_catalog_timeout",
            "boundary": boundary,
        });
        let error =
            response_status_error(reqwest::StatusCode::SERVICE_UNAVAILABLE, &body.to_string());
        assert!(error.http_message() == Some("unavailable"));
    }
    let error = response_status_error(
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        r#"{"error":"unavailable","code":"channel_catalog_timeout"}"#,
    );
    assert!(error.http_message() == Some("unavailable"));
}

#[test]
fn other_refusals_keep_their_status_and_message() {
    let body = r#"{"error":"refused","code":"channel_catalog_timeout","boundary":"directory"}"#;
    for status in [
        reqwest::StatusCode::FORBIDDEN,
        reqwest::StatusCode::BAD_REQUEST,
    ] {
        assert!(response_status_error(status, body).http_message() == Some("refused"));
    }
    assert!(
        matches!(response_status_error(reqwest::StatusCode::UPGRADE_REQUIRED, body),
        CliError::UpgradeRequired(detail) if detail == "refused")
    );
    let error = response_status_error(
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        r#"{"error":"unavailable","code":"postgres_unavailable","boundary":"directory"}"#,
    );
    assert!(error.http_message() == Some("unavailable"));
}
