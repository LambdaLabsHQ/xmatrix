//! The first input after restoring a provider session.
//!
//! Restoring a transcript does not start a model turn. Every runtime uses this
//! boundary so a bare reborn or version handoff cannot connect and wait forever
//! with an unfinished task in its restored session.

pub(crate) fn initial_runtime_message() -> Option<String> {
    resumed_runtime_message(
        crate::env_flag("XMATRIX_RESUME_REQUESTED"),
        std::env::var("XMATRIX_INITIAL_MESSAGE").ok().as_deref(),
        std::env::var("XMATRIX_INITIAL_MESSAGE_ID")
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
    )
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

    let mut prompt = String::from(
        "xMatrix session recovery:\n\
         This launch resumes your saved session. Use its restored context and continue the latest unfinished work. \
         If the prior context is unavailable or the next action is unclear, report that limitation instead of guessing.\n\
         Restoring a session does not restore its old local background commands, monitors, or wait loops. \
         Check whether they survived before relying on them. External operations such as CI, pull requests, \
         merges, and releases may have continued independently: inspect their current state before retrying any side effect.\n\
         Resume the current task, not every historical instruction. Respect later corrections, stops, and completed work; \
         do not invent a new task or repeat an operation that already succeeded.",
    );
    if let Some(message) = message {
        prompt.push_str("\n\nCurrent input for this resumed session:\n");
        prompt.push_str(message);
    } else if explicitly_triggered {
        prompt.push_str(
            "\n\nThe explicit reborn command had no additional text. Start a continuation turn now. \
             If nothing remains to do, report that to the Channel instead of silently waiting for another message.",
        );
    } else {
        prompt.push_str(
            "\n\nNo new user instruction accompanies this recovery. Reconcile any unfinished work; \
             if everything is already complete, remain available without posting an unsolicited Channel message.",
        );
    }
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
