use clap::{Args, Subcommand, ValueEnum};

#[derive(Args)]
pub struct HarnessTargetArgs {
    /// Machine ID or unambiguous machine name; defaults to this machine
    #[arg(long)]
    pub machine: Option<String>,
    /// Print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum HarnessAutoUpdateState {
    On,
    Off,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum HarnessApplyAction {
    Install,
    Update,
    Uninstall,
    #[value(name = "auto_update_on")]
    AutoUpdateOn,
    #[value(name = "auto_update_off")]
    AutoUpdateOff,
    Refresh,
    /// Read the registry now and apply the automatic-update policy
    Release,
}

include!("../../../shared/harness_action_names.rs");

impl HarnessApplyAction {
    harness_action_names!();
}

#[derive(Subcommand)]
pub enum HarnessCommand {
    /// List reported harnesses; Agent Runs default to a fresh local probe
    List {
        #[arg(long, conflicts_with = "machine")]
        local: bool,
        /// Machine ID or unambiguous machine name; omit to list all owned machines
        #[arg(long)]
        machine: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Install a harness using its official recipe
    Install {
        preset_id: String,
        #[command(flatten)]
        target: HarnessTargetArgs,
    },
    /// Update a harness using its official recipe
    Update {
        preset_id: String,
        #[command(flatten)]
        target: HarnessTargetArgs,
    },
    /// Remove a harness using its official recipe; settings and sessions are kept
    Uninstall {
        preset_id: String,
        #[command(flatten)]
        target: HarnessTargetArgs,
    },
    /// Enable or disable automatic updates (native updater or xMatrix schedule)
    AutoUpdate {
        preset_id: String,
        #[arg(value_enum)]
        state: HarnessAutoUpdateState,
        #[command(flatten)]
        target: HarnessTargetArgs,
    },
    /// Request an immediate inventory refresh
    Refresh {
        #[command(flatten)]
        target: HarnessTargetArgs,
    },
    /// Read the outcome of a previously queued remote action
    Status {
        control_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Owner-side executor used by an approved daemon request
    #[command(hide = true)]
    Apply {
        preset_id: String,
        #[arg(value_enum)]
        action: HarnessApplyAction,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn local_inventory_and_remote_target_are_mutually_exclusive() {
        assert!(Cli::try_parse_from(["xmatrix", "harness", "list", "--local", "--json"]).is_ok());
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "harness",
                "list",
                "--local",
                "--machine",
                "other"
            ])
            .is_err()
        );
    }

    #[test]
    fn action_shell_only_accepts_closed_actions_and_explicit_targets() {
        assert!(Cli::try_parse_from(["xmatrix", "harness", "apply", "codex", "shell"]).is_err());
        let cli = Cli::try_parse_from([
            "xmatrix",
            "harness",
            "auto-update",
            "codex",
            "off",
            "--machine",
            "workstation",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Harness {
                command: HarnessCommand::AutoUpdate {
                    state: HarnessAutoUpdateState::Off,
                    target: HarnessTargetArgs { json: true, .. },
                    ..
                }
            })
        ));
    }
}
