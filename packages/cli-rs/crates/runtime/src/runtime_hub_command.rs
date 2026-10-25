//! Commands the Hub defines (docs/architecture/hub-cli-commands.md).
//!
//! A word after `xmatrix` that this CLI does not know, and that names no
//! harness, goes to the Hub with the rest of the command line. The Hub parses
//! it, acts through its own routes with this caller's credential, and returns
//! what to print and the exit code, so such a command changes with a Hub
//! deploy. A word the Hub does not know either is reported here as an unknown
//! command.

use serde::Deserialize;

/// Whether `args` (the words after `xmatrix`) may name a Hub command: a plain
/// lowercase word that is neither a harness launcher nor the runtime this
/// process was spawned to run (`xmatrix <runtime> …` inside a Run).
pub(crate) fn hub_command_candidate(args: &[String]) -> bool {
    let Some(word) = args.first() else {
        return false;
    };
    let plain = word.starts_with(|c: char| c.is_ascii_lowercase())
        && word
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let spawned = std::env::var("XMATRIX_SPAWN_RUNTIME")
        .is_ok_and(|runtime| xmatrix_cli_agent::launcher_stem(&runtime) == *word);
    plain && !spawned && xmatrix_cli_agent::agent_preset_for_launcher(word).is_none()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubCommandOutput {
    #[serde(default)]
    unknown_command: bool,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    exit_code: i32,
}

/// Runs `args` on the Hub. `Ok(None)` when the Hub defines no such command.
pub(crate) async fn run_hub_command(
    hub_url: &str,
    token: &str,
    args: &[String],
) -> crate::error::Result<Option<i32>> {
    let output: HubCommandOutput = crate::http::request_json(
        &crate::with_route(hub_url, "/api/cli/commands/run"),
        "POST",
        Some(token),
        Some(serde_json::json!({ "argv": args })),
    )
    .await?;
    if output.unknown_command {
        return Ok(None);
    }
    print!("{}", output.stdout);
    eprint!("{}", output.stderr);
    Ok(Some(output.exit_code))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_plain_word_that_names_no_harness_goes_to_the_hub() {
        let candidate = |line: &str| {
            let words: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
            super::hub_command_candidate(&words)
        };
        let _guard = crate::tests::test_process_env_lock();
        let previous = std::env::var_os("XMATRIX_SPAWN_RUNTIME");
        unsafe { std::env::remove_var("XMATRIX_SPAWN_RUNTIME") };
        assert!(candidate("automation list"));
        assert!(candidate("commands"));
        assert!(!candidate("claude --resume"));
        assert!(!candidate("/opt/tool"));
        assert!(!candidate("Tool"));
        assert!(!candidate(""));
        unsafe { std::env::set_var("XMATRIX_SPAWN_RUNTIME", "/usr/local/bin/mytool") };
        assert!(!candidate("mytool"), "the Run's own runtime");
        assert!(candidate("automation"));
        match previous {
            Some(value) => unsafe { std::env::set_var("XMATRIX_SPAWN_RUNTIME", value) },
            None => unsafe { std::env::remove_var("XMATRIX_SPAWN_RUNTIME") },
        }
    }
}
