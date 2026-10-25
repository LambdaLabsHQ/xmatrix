//! A word after `xmatrix` that is not one of its commands reaches clap's
//! external-subcommand passthrough, which exists so the daemon can start a
//! harness inside an Agent Run (`xmatrix claude …`). Outside a Run, a word
//! that names no harness is a mistyped command, and is reported the way clap
//! reports any other unknown command instead of as a refused Agent Run.

use clap::CommandFactory;
use clap::error::{ContextKind, ContextValue, ErrorKind};
use xmatrix_cli_args::{Cli, Commands};

/// Clap's own threshold for "did you mean" suggestions.
const SUGGESTION_CONFIDENCE: f64 = 0.7;

/// The usage error for a mistyped command, or `None` when the passthrough
/// should go ahead: inside a Run, or for a word that names a known harness.
pub fn unknown_command_error(cli: &Cli) -> Option<clap::Error> {
    let Some(Commands::External(args)) = &cli.command else {
        return None;
    };
    let in_run = std::env::var("XMATRIX_RUN_ID").is_ok_and(|run| !run.trim().is_empty());
    unknown_command_error_for(args, in_run)
}

fn unknown_command_error_for(args: &[String], in_run: bool) -> Option<clap::Error> {
    let word = args.first()?;
    // A word the Hub may define is asked of it first (`runtime_hub_command`).
    if in_run
        || xmatrix_cli_agent::agent_preset_for_launcher(word).is_some()
        || crate::runtime_hub_command::hub_command_candidate(args)
    {
        return None;
    }
    Some(unrecognized_command(word))
}

/// The usage error clap gives a mistyped command, with its suggestion.
pub(crate) fn unrecognized_command(word: &str) -> clap::Error {
    let word = &word.to_string();
    let mut command = Cli::command();
    command.build();
    let suggestions = suggested_commands(&command, word);
    let mut error = clap::Error::new(ErrorKind::InvalidSubcommand).with_cmd(&command);
    error.insert(
        ContextKind::InvalidSubcommand,
        ContextValue::String(word.clone()),
    );
    if !suggestions.is_empty() {
        error.insert(
            ContextKind::SuggestedSubcommand,
            ContextValue::Strings(suggestions),
        );
    }
    error.insert(
        ContextKind::Usage,
        ContextValue::StyledStr(command.render_usage()),
    );
    error
}

/// Visible commands close to `word`, closest first.
fn suggested_commands(command: &clap::Command, word: &str) -> Vec<String> {
    let mut scored: Vec<(f64, String)> = command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set())
        .flat_map(|subcommand| {
            std::iter::once(subcommand.get_name()).chain(subcommand.get_visible_aliases())
        })
        .map(|name| (strsim::jaro(word, name), name.to_string()))
        .filter(|(confidence, _)| *confidence > SUGGESTION_CONFIDENCE)
        .collect();
    scored.sort_by(|left, right| right.0.total_cmp(&left.0));
    scored.into_iter().map(|(_, name)| name).take(1).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn a_typo_outside_a_run_is_an_unknown_command_with_a_suggestion() {
        let error = unrecognized_command("logn");
        assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
        let rendered = error.render().to_string();
        assert!(
            rendered.contains("unrecognized subcommand 'logn'"),
            "{rendered}"
        );
        assert!(rendered.contains("'login'"), "{rendered}");
        assert!(!rendered.contains("Agent Run"), "{rendered}");
    }

    #[test]
    fn a_word_far_from_every_command_gets_no_suggestion() {
        let error = unrecognized_command("zzzzqqq");
        let rendered = error.render().to_string();
        assert!(
            rendered.contains("unrecognized subcommand 'zzzzqqq'"),
            "{rendered}"
        );
        assert!(!rendered.contains("similar subcommand"), "{rendered}");
    }

    #[test]
    fn a_known_harness_keeps_the_passthrough() {
        assert!(unknown_command_error_for(&args(&["claude"]), false).is_none());
        assert!(unknown_command_error_for(&args(&["codex", "--help"]), false).is_none());
    }

    #[test]
    fn a_plain_word_is_asked_of_the_hub_before_it_is_called_unknown() {
        assert!(unknown_command_error_for(&args(&["automation", "list"]), false).is_none());
        assert!(unknown_command_error_for(&args(&["Logn"]), false).is_some());
    }

    #[test]
    fn inside_a_run_every_word_keeps_the_passthrough() {
        assert!(unknown_command_error_for(&args(&["logn"]), true).is_none());
    }
}
