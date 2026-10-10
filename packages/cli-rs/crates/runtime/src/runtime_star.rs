//! `xmatrix star`: a person stars the xMatrix repository on GitHub.
//!
//! A star is a person's own choice, and GitHub forbids automated starring. The
//! command therefore refuses inside an Agent run and wherever no person is at
//! the terminal, so nothing an Agent runs can star on someone's behalf. With a
//! signed-in GitHub CLI it stars directly; otherwise it opens the repository.

use std::io::IsTerminal;
use std::process::Stdio;
use std::time::Duration;

use xmatrix_cli_core::error::{CliError, Result};

const REPOSITORY: &str = "LambdaLabsHQ/xmatrix";
const REPOSITORY_URL: &str = "https://github.com/LambdaLabsHQ/xmatrix";
/// Nothing waits on this answer, so a `gh` that hangs falls back to the browser.
const GITHUB_CLI_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn cmd_star() -> Result<()> {
    refuse_unless_a_person_asked(
        xmatrix_cli_channel::running_inside_agent_execution_context(),
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
    )?;
    if star_with_github_cli().await {
        println!("Starred {REPOSITORY}. Thank you.");
        return Ok(());
    }
    open::that(REPOSITORY_URL)
        .map_err(|e| CliError::Launch(format!("Could not open {REPOSITORY_URL}: {e}")))?;
    println!("Opened {REPOSITORY_URL}. Star it there.");
    Ok(())
}

fn refuse_unless_a_person_asked(agent_run: bool, interactive_terminal: bool) -> Result<()> {
    if agent_run {
        return Err(CliError::Auth(
            "Agent runs cannot star a repository; a star is a person's own choice".into(),
        ));
    }
    if !interactive_terminal {
        return Err(CliError::Auth(format!(
            "xmatrix star needs a person at an interactive terminal; you can also star at {REPOSITORY_URL}"
        )));
    }
    Ok(())
}

/// True only when `gh` confirmed the star. A missing or signed-out `gh`, a
/// refusal, and a timeout all leave the choice to the browser.
async fn star_with_github_cli() -> bool {
    let status = tokio::process::Command::new("gh")
        .args([
            "api",
            "--method",
            "PUT",
            &format!("user/starred/{REPOSITORY}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    matches!(
        tokio::time::timeout(GITHUB_CLI_TIMEOUT, status).await,
        Ok(Ok(status)) if status.success()
    )
}

#[cfg(test)]
mod tests {
    use super::refuse_unless_a_person_asked;

    #[test]
    fn only_a_person_at_a_terminal_may_star() {
        assert!(refuse_unless_a_person_asked(false, true).is_ok());
        let agent = refuse_unless_a_person_asked(true, true)
            .unwrap_err()
            .to_string();
        assert!(agent.contains("Agent runs cannot star"), "{agent}");
        let piped = refuse_unless_a_person_asked(false, false)
            .unwrap_err()
            .to_string();
        assert!(piped.contains("interactive terminal"), "{piped}");
    }
}
