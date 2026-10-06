use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("xmatrix-send-journal-{}", uuid::Uuid::new_v4())))
    }
    fn prepare(&self, body: &str) -> Result<SendLease, String> {
        SendLease::prepare(&self.0, scope(), serde_json::json!({"body": body}), 123)
    }
    fn record_path(&self) -> PathBuf {
        fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scope() -> SendScope {
    SendScope {
        profile_id: Some("profile".into()),
        hub_origin: "https://hub.test".into(),
        channel_id: "channel".into(),
        message_id: "message".into(),
        agent_id: "agent".into(),
        instance_id: "instance".into(),
        run_id: "run".into(),
        execution_fingerprint: fingerprint(b"SECRET"),
    }
}

#[test]
fn lost_response_survives_reopen_without_claiming_publication() {
    let fixture = Fixture::new();
    let first = fixture.prepare("private reply").unwrap();
    assert!(!first.record.committed);
    assert!(
        fixture.prepare("private reply").is_err(),
        "concurrent send must not race"
    );
    drop(first); // cancellation/process exit without a Hub response
    let reopened = fixture.prepare("private reply").unwrap();
    assert_eq!(reopened.record.created_at, 123);
    assert_eq!(
        reopened.record.payload.as_ref().unwrap()["body"],
        "private reply"
    );
    assert!(!reopened.record.committed);
    let bytes = fs::read_to_string(fixture.record_path()).unwrap();
    assert!(!bytes.contains("SECRET"));
    reopened.confirm().unwrap();
    let committed = fixture.prepare("private reply").unwrap();
    assert!(committed.record.committed);
    assert!(committed.record.payload.is_none());
    assert!(
        !fs::read_to_string(fixture.record_path())
            .unwrap()
            .contains("private reply")
    );
}

#[test]
fn recovery_reads_only_the_exact_saved_operation_and_bounds_retry_age() {
    let fixture = Fixture::new();
    drop(fixture.prepare("saved reply").unwrap());
    let mut wrong = scope();
    wrong.instance_id = "other-instance".into();
    assert!(SendLease::open(&fixture.0, &wrong).is_err());
    let lease = SendLease::open(&fixture.0, &scope()).unwrap();
    assert_eq!(lease.retry_payload(123).unwrap()["body"], "saved reply");
    assert!(lease.retry_payload(122).is_err());
    assert!(lease.retry_payload(123 + 86401).is_err());
    assert!(SendLease::open(&fixture.0, &scope()).is_err());
    lease.confirm().unwrap();
    let confirmed = SendLease::open(&fixture.0, &scope()).unwrap();
    assert!(confirmed.retry_payload(123).is_err());
    assert!(confirmed.submission_fingerprint().is_some());
}

#[cfg(unix)]
#[test]
fn releasing_an_operation_unlocks_even_when_a_child_inherits_its_descriptor() {
    let fixture = Fixture::new();
    let first = fixture.prepare("reply").unwrap();
    let inherited = first._operation_lock.0.try_clone().unwrap();
    drop(first);
    let next = fixture.prepare("reply");
    drop(inherited);
    assert!(
        next.is_ok(),
        "a duplicated descriptor cannot retain a released operation lock"
    );
}

#[test]
fn changed_content_or_identity_cannot_replace_the_original_operation() {
    let fixture = Fixture::new();
    drop(fixture.prepare("first").unwrap());
    let before = fs::read(fixture.record_path()).unwrap();
    assert!(fixture.prepare("different").is_err());
    for field in ["profile", "agent", "instance", "run", "execution"] {
        let mut changed = scope();
        match field {
            "profile" => changed.profile_id = Some("other".into()),
            "agent" => changed.agent_id = "other".into(),
            "instance" => changed.instance_id = "other".into(),
            "run" => changed.run_id = "other".into(),
            _ => changed.execution_fingerprint = "other".into(),
        }
        assert!(
            SendLease::prepare(
                &fixture.0,
                changed,
                serde_json::json!({"body":"first"}),
                456
            )
            .is_err()
        );
    }
    assert_eq!(fs::read(fixture.record_path()).unwrap(), before);
}

#[test]
fn attachments_are_part_of_the_immutable_send_fingerprint() {
    let fixture = Fixture::new();
    let payload =
        |hash: &str| serde_json::json!({"body": "same", "attachments": [{"contentHash": hash}]});
    drop(SendLease::prepare(&fixture.0, scope(), payload("a"), 1).unwrap());
    assert!(SendLease::prepare(&fixture.0, scope(), payload("b"), 2).is_err());
}

#[test]
fn damaged_or_future_schema_records_fail_closed_without_overwrite() {
    let fixture = Fixture::new();
    drop(fixture.prepare("reply").unwrap());
    let path = fixture.record_path();
    let original = fs::read_to_string(&path).unwrap();
    for invalid in [
        "broken".to_string(),
        original.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
    ] {
        fs::write(&path, &invalid).unwrap();
        assert!(fixture.prepare("reply").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    }
}

#[test]
fn storage_and_payload_limits_preserve_existing_records() {
    let fixture = Fixture::new();
    drop(fixture.prepare("reply").unwrap());
    assert!(
        fixture
            .prepare(&"x".repeat(MAX_RECORD_BYTES as usize))
            .is_err()
    );
    let path = fixture.record_path();
    let original = fs::read(&path).unwrap();
    // A interrupted oversized temporary file consumes the admission budget.
    let file = File::create(fixture.0.join("interrupted.tmp")).unwrap();
    file.set_len(MAX_TOTAL_BYTES).unwrap();
    let mut next = scope();
    next.message_id = "next".into();
    assert!(SendLease::prepare(&fixture.0, next, serde_json::json!({"body":"reply"}), 2).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    // Existing operations remain readable even when new admission is full.
    drop(fixture.prepare("reply").unwrap());
}

#[test]
fn different_messages_do_not_hold_a_global_network_lock() {
    let fixture = Fixture::new();
    let first = fixture.prepare("one").unwrap();
    let mut next = scope();
    next.message_id = "second".into();
    let second =
        SendLease::prepare(&fixture.0, next, serde_json::json!({"body":"two"}), 2).unwrap();
    second.confirm().unwrap();
    first.confirm().unwrap();
}

#[test]
fn reclamation_preserves_pending_and_busy_operations() {
    let fixture = Fixture::new();
    drop(fixture.prepare("pending").unwrap());
    let pending_path = fixture.record_path();
    let mut next = scope();
    next.message_id = "confirmed".into();
    let payload = serde_json::json!({"body": "committed reply"});
    SendLease::prepare(&fixture.0, next.clone(), payload.clone(), 2)
        .unwrap()
        .confirm()
        .unwrap();
    let committed_path = fixture
        .0
        .join(format!("{}.json", scope_key(&next).unwrap()));
    let active = SendLease::prepare(&fixture.0, next, payload, 3).unwrap();
    let mut count = 5;
    let mut total = 1;
    reclaim_confirmed(&fixture.0, &mut count, &mut total, MAX_TOTAL_BYTES).unwrap();
    assert!(pending_path.exists());
    assert!(committed_path.exists(), "busy records cannot be reclaimed");
    drop(active);
    reclaim_confirmed(&fixture.0, &mut count, &mut total, MAX_TOTAL_BYTES).unwrap();
    assert!(pending_path.exists());
    assert!(!committed_path.exists());
    assert_eq!(count, 3);
    assert_eq!(
        fixture.prepare("pending").unwrap().record.payload.unwrap()["body"],
        "pending"
    );
}

#[cfg(unix)]
#[test]
fn journal_is_private_and_does_not_follow_record_symlinks() {
    use std::os::unix::fs::{PermissionsExt as _, symlink};
    let fixture = Fixture::new();
    drop(fixture.prepare("private reply").unwrap());
    let path = fixture.record_path();
    assert_eq!(
        fs::metadata(&fixture.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let target = Fixture::new();
    fs::write(&target.0, "keep").unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&target.0, &path).unwrap();
    assert!(fixture.prepare("private reply").is_err());
    assert_eq!(fs::read_to_string(&target.0).unwrap(), "keep");
    fs::remove_file(&target.0).unwrap();
}

#[test]
fn recovery_inventory_is_exact_and_survives_content_compaction() {
    let fixture = Fixture::new();
    let execution = "11111111-1111-4111-8111-111111111111";
    let payload = serde_json::json!({"body":"PRIVATE_BODY", "finalReplyExecutionId":execution});
    let first = SendLease::prepare(&fixture.0, scope(), payload.clone(), 123).unwrap();
    drop(first);
    let mut peer = scope();
    peer.run_id = "other-run".into();
    peer.message_id = "other-message".into();
    drop(SendLease::prepare(&fixture.0, peer, payload.clone(), 124).unwrap());
    assert_eq!(
        execution_sends(&fixture.0, &scope(), execution).unwrap(),
        vec![("message".into(), 123)]
    );
    SendLease::open(&fixture.0, &scope())
        .unwrap()
        .confirm()
        .unwrap();
    assert_eq!(
        execution_sends(&fixture.0, &scope(), execution).unwrap(),
        vec![("message".into(), 123)]
    );
    let own_path = fixture
        .0
        .join(format!("{}.json", scope_key(&scope()).unwrap()));
    assert!(
        !fs::read_to_string(&own_path)
            .unwrap()
            .contains("PRIVATE_BODY")
    );
    assert!(
        execution_sends(&fixture.0, &scope(), "22222222-2222-4222-8222-222222222222")
            .unwrap()
            .is_empty()
    );
    let mut second = scope();
    second.message_id = "message-2".into();
    drop(SendLease::prepare(&fixture.0, second, payload, 125).unwrap());
    assert_eq!(
        execution_sends(&fixture.0, &scope(), execution)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn pending_recovery_reference_cannot_disagree_with_the_saved_payload() {
    let fixture = Fixture::new();
    let execution = "11111111-1111-4111-8111-111111111111";
    drop(
        SendLease::prepare(
            &fixture.0,
            scope(),
            serde_json::json!({"body":"reply", "finalReplyExecutionId":execution}),
            123,
        )
        .unwrap(),
    );
    let path = fixture.record_path();
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["finalReplyExecutionId"] = serde_json::json!("22222222-2222-4222-8222-222222222222");
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(execution_sends(&fixture.0, &scope(), "22222222-2222-4222-8222-222222222222").is_err());
}

#[test]
fn a_full_journal_with_a_stray_file_still_admits_and_reclaims_to_half() {
    let fixture = Fixture::new();
    let payload = serde_json::json!({"body": "sent"});
    let mut first = scope();
    first.message_id = "sent-0".into();
    SendLease::prepare(&fixture.0, first, payload.clone(), 0)
        .unwrap()
        .confirm()
        .unwrap();
    let mut record: Record =
        serde_json::from_slice(&fs::read(fixture.record_path()).unwrap()).unwrap();
    // Seed the persisted history directly. Repeated prepare/confirm scans the
    // growing directory and fsyncs each intermediate state; this test exercises
    // admission and reclamation at full capacity, not a thousand prior sends.
    for index in 1..(MAX_ENTRIES - 1) / 2 {
        record.scope.message_id = format!("sent-{index}");
        record.created_at = index as u64;
        record.agent_send_fingerprint =
            crate::runtime_send_submission::submission_fingerprint(&record.scope, &payload);
        let key = scope_key(&record.scope).unwrap();
        let path = fixture.0.join(format!("{key}.json"));
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        private(&path, false).unwrap();
        let lock_path = path.with_extension("lock");
        File::create(&lock_path).unwrap();
        private(&lock_path, false).unwrap();
    }
    assert!(
        SendLease::open(&fixture.0, &record.scope)
            .unwrap()
            .record
            .committed
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), MAX_ENTRIES);
    // An interrupted write leaves one more entry than the journal ever plans for.
    File::create(fixture.0.join("interrupted.tmp")).unwrap();
    let admitted = fixture.prepare("next").unwrap();
    assert!(fs::read_dir(&fixture.0).unwrap().count() <= RECLAIM_TO_ENTRIES + 3);
    admitted.confirm().unwrap();
}
