//! The first input after restoring a provider session.
//!
//! Restoring a transcript does not start a model turn. Every runtime uses this
//! boundary so a bare reborn or version handoff cannot connect and wait forever
//! with an unfinished task in its restored session. Its words are official
//! texts the Hub delivers (`prompts/session-recovery*.md`).

use xmatrix_cli_core::bootstrap::official_text;

pub(crate) fn initial_runtime_message() -> Option<String> {
    resumed_runtime_message(
        crate::env_flag("XMATRIX_RESUME_REQUESTED"),
        std::env::var("XMATRIX_INITIAL_MESSAGE").ok().as_deref(),
        std::env::var("XMATRIX_INITIAL_MESSAGE_ID")
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
    )
    // A resumed session reads no history, so it finds no message to frame.
    .map(|message| crate::runtime_channel_history_bootstrap::initial_message_turn(&message))
}

/// A co-writing invitation and the page's first request are one model turn:
/// otherwise an ordinary task can keep the live document queued for minutes.
pub(crate) async fn initial_runtime_turn() -> crate::error::Result<Option<String>> {
    let Some(mut message) = initial_runtime_message() else {
        return Ok(None);
    };
    if let Some(channel_id) = crate::non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID")
        && let Some(page) = crate::runtime_page_co_write::initial_prompt(&channel_id).await?
    {
        use crate::runtime_page_co_write::InitialPageInput;
        match page {
            InitialPageInput::Complete(input) => return Ok(Some(input)),
            InitialPageInput::Legacy(input) => {
                message.push_str("\n\n");
                message.push_str(&input);
            }
        }
    }
    Ok(Some(message))
}

fn resumed_runtime_message(
    resumed: bool,
    message: Option<&str>,
    explicitly_triggered: bool,
) -> Option<String> {
    let message = message.map(str::trim).filter(|value| !value.is_empty());
    if !resumed {
        return message.map(str::to_owned);
    }

    let continuation = match message {
        Some(message) => official_text("session-recovery-input", &[("message", message)]),
        None if explicitly_triggered => official_text("session-recovery-reborn", &[]),
        None => official_text("session-recovery-quiet", &[]),
    };
    let prompt = official_text(
        "session-recovery",
        &[("continuation", continuation.trim_end())],
    )
    .trim_end()
    .to_string();
    Some(prompt)
}

#[cfg(test)]
mod tests {
    use super::resumed_runtime_message;

    #[test]
    fn launch_environment_produces_input_for_a_restored_session() {
        let _guard = crate::tests::test_process_env_lock();
        let keys = [
            "XMATRIX_RESUME_REQUESTED",
            "XMATRIX_INITIAL_MESSAGE",
            "XMATRIX_INITIAL_MESSAGE_ID",
        ];
        let prior = keys.map(std::env::var_os);
        unsafe {
            std::env::set_var(keys[0], "1");
            std::env::remove_var(keys[1]);
            std::env::set_var(keys[2], "reborn-source");
        }
        let input = super::initial_runtime_message();
        for (key, value) in keys.into_iter().zip(prior) {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
        assert!(input.unwrap().contains("Start a continuation turn now"));
    }

    #[test]
    fn a_fresh_idle_session_still_has_no_task() {
        assert_eq!(resumed_runtime_message(false, None, false), None);
        assert_eq!(resumed_runtime_message(false, Some(" \n "), true), None);
    }

    #[test]
    fn fresh_input_keeps_its_existing_bytes_after_outer_trim() {
        assert_eq!(
            resumed_runtime_message(false, Some("  fix it\n\n  keep formatting  "), true),
            Some("fix it\n\n  keep formatting".into()),
        );
    }

    #[test]
    fn a_bare_reborn_starts_a_continuation_without_replaying_the_old_assignment() {
        let input = resumed_runtime_message(true, None, true).unwrap();
        assert!(input.contains("Start a continuation turn now"));
        assert!(input.contains("latest unfinished work"));
        assert!(input.contains("inspect their current state before retrying any side effect"));
        assert!(!input.contains("Current input for this resumed session:"));
    }

    #[test]
    fn message_wake_keeps_the_new_input_after_the_recovery_context() {
        let input =
            resumed_runtime_message(true, Some("Continue #3186\nKeep its reviews."), true).unwrap();
        assert!(input.ends_with(
            "Current input for this resumed session:\nContinue #3186\nKeep its reviews."
        ));
        assert!(input.contains("old local background commands"));
        assert!(!input.contains("had no additional text"));
    }

    #[test]
    fn a_version_handoff_reconciles_work_without_fabricating_a_user_message() {
        let input = resumed_runtime_message(true, Some("  "), false).unwrap();
        assert!(input.contains("No new user instruction accompanies this recovery"));
        assert!(input.contains("without posting an unsolicited Channel message"));
        assert!(!input.contains("explicit reborn command"));
    }
}
