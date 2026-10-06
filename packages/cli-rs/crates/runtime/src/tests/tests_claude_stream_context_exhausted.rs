// A Claude session whose context window is full (`terminal_reason:
// prompt_too_long`) is retired: the turn fails with that reason and the next
// turn starts a fresh session instead of resuming the exhausted one.

/// First run: a session that ends its turn with an exhausted context window.
/// Any later run answers normally. Each run records its argv so the test can
/// tell whether it resumed.
const CLAUDE_CONTEXT_EXHAUSTED: &str = r#"root="$1"
emit() { printf '%s\n' "$1"; }
runs=$(cat "$root/runs" 2>/dev/null || echo 0)
echo $((runs + 1)) > "$root/runs"
printf '%s\n' "$*" > "$root/args-$runs"
IFS= read -r _ || exit 0
if [ "$runs" -gt 0 ]; then
  emit '{"type":"system","subtype":"init","session_id":"s2","model":"claude-test"}'
  emit '{"type":"result","subtype":"success","is_error":false,"result":"FRESH","session_id":"s2"}'
  sleep 30
  exit 0
fi
emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Reading the logs"}]},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","is_error":__IS_ERROR__,"terminal_reason":"prompt_too_long","result":"Prompt is too long","session_id":"s1"}'
sleep 30
"#;

async fn claude_context_exhausted_turns(is_error: bool) {
    let mut fixture = ClaudeCliTurnFixture::start(
        &CLAUDE_CONTEXT_EXHAUSTED.replace("__IS_ERROR__", if is_error { "true" } else { "false" }),
    )
    .await;

    let exhausted = fixture.submit("first").await;
    assert!(matches!(exhausted.status, ClaudeTurnStatus::Failed));
    assert!(
        exhausted.answer.contains("terminal_reason=prompt_too_long")
            && exhausted.answer.contains("fresh Claude session")
            && exhausted.answer.contains("(Prompt is too long)"),
        "{}",
        exhausted.answer
    );
    assert_eq!(fixture.session.current_session_id(), None);

    let fresh = fixture.submit("second").await;
    assert!(matches!(fresh.status, ClaudeTurnStatus::Completed));
    assert_eq!(fresh.answer, "FRESH");
    let respawn_args = std::fs::read_to_string(fixture.root.join("args-1")).unwrap();
    assert!(
        !respawn_args.contains("--resume"),
        "the exhausted session was resumed: {respawn_args}"
    );
    fixture.finish().await;
}

#[tokio::test]
async fn claude_exhausted_context_error_result_retires_the_session() {
    claude_context_exhausted_turns(true).await;
}

#[tokio::test]
async fn claude_exhausted_context_without_is_error_still_fails_and_retires() {
    // The CLI computes is_error and terminal_reason independently; a result
    // that only carries the terminal reason is not a completed answer.
    claude_context_exhausted_turns(false).await;
}

#[test]
fn claude_retired_resume_id_is_cleared_only_while_it_names_that_session() {
    // The resume store lives under XMATRIX_CONFIG_DIR, which other tests
    // repoint; without the lock a save and the load after it can land in two
    // different directories.
    let _guard = test_process_env_lock();
    use crate::runtime_claude_turn::{
        clear_claude_resume_session_id, load_claude_resume_session_id,
        save_claude_resume_session_id,
    };
    let key = format!("context-exhausted-{}", uuid::Uuid::new_v4());
    save_claude_resume_session_id(Some(&key), Some("s-new")).unwrap();
    clear_claude_resume_session_id(Some(&key), Some("s-old"));
    assert_eq!(
        load_claude_resume_session_id(Some(&key)).as_deref(),
        Some("s-new")
    );
    clear_claude_resume_session_id(Some(&key), Some("s-new"));
    assert_eq!(load_claude_resume_session_id(Some(&key)), None);
}
