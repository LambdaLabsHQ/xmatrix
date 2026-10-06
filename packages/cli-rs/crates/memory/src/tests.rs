use xmatrix_cli_core::protocol::SerializedAnnotation;

#[test]
fn a_postgres_annotation_without_channel_or_author_still_parses() {
    let parsed: SerializedAnnotation = serde_json::from_value(serde_json::json!({
        "id": "a1", "namespace": "ns", "target": { "kind": "message", "messageId": "m1" },
        "payload": {}, "authorUserId": "user-1", "authorLabel": "User",
        "createdAt": "2026-09-25T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(parsed.author, "user-1");
    assert_eq!(parsed.channel_id, "");
}
