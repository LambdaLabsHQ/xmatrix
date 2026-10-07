use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};
mod harness;
pub use harness::{HarnessApplyAction, HarnessAutoUpdateState, HarnessCommand, HarnessTargetArgs};

#[derive(Parser)]
#[command(
    name = "xmatrix",
    about = "xMatrix CLI — AI cross-ecosystem communication"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
    /// Select a local connection profile
    #[arg(
        long,
        env = "XMATRIX_PROFILE",
        global = true,
        conflicts_with_all = ["environment", "hub_url"]
    )]
    pub profile: Option<String>,
    /// Hub URL override for a custom deployment
    #[arg(
        long,
        env = "XMATRIX_HUB_URL",
        global = true,
        conflicts_with_all = ["environment", "profile"]
    )]
    pub hub_url: Option<String>,
    /// Select the built-in production or test environment
    #[arg(
        long,
        env = "XMATRIX_ENVIRONMENT",
        global = true,
        value_enum,
        conflicts_with_all = ["hub_url", "profile"]
    )]
    pub environment: Option<CliEnvironmentArg>,
    /// Auth token override
    #[arg(long, env = "XMATRIX_TOKEN")]
    pub token: Option<String>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum CliEnvironmentArg {
    Production,
    Test,
}

impl CliEnvironmentArg {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Test => "test",
        }
    }
}

#[derive(Subcommand)]
pub enum SetupCommand {
    /// Install the daemon startup entry (launchd on macOS, systemd --user on
    /// Linux) for one binary and start it now
    Daemon {
        /// Daemon binary to register; defaults to this executable
        #[arg(long)]
        binary: Option<PathBuf>,
    },
    /// Copy this binary (or another seed) into the user's bin directory,
    /// prove the copy runs, and optionally register the daemon from it
    Install {
        /// Seed binary to copy; defaults to this executable
        #[arg(long)]
        from: Option<PathBuf>,
        /// Directory to install into; defaults to ~/.local/bin
        #[arg(long)]
        into: Option<PathBuf>,
        /// Also register and start the daemon from the installed copy
        #[arg(long)]
        daemon: bool,
        /// Print the result as one JSON line
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum SessionCommand {
    /// Save a session read from stdin as JSON (`{token, refreshToken, user,
    /// hubUrl, relayUrl}`) and hot-reload it into the running daemon
    Import {
        /// Read the session JSON from stdin (required: tokens never go on
        /// the command line)
        #[arg(long)]
        stdin: bool,
        /// Print the result as one JSON line
        #[arg(long)]
        json: bool,
    },
    /// Print the selected profile, its saved session without tokens, and
    /// the machine id
    Show {
        /// Print as JSON
        #[arg(long)]
        json: bool,
        /// Include the access token (for a local client that owns the store)
        #[arg(long)]
        with_token: bool,
    },
}

#[derive(Subcommand)]
pub enum EnvironmentCommand {
    /// List the built-in environments and the active selection
    List,
    /// Print the active environment
    Current,
    /// Change the environment used by commands and the local daemon
    Use {
        #[arg(value_enum)]
        environment: CliEnvironmentArg,
    },
}

#[derive(Subcommand)]
pub enum ProfileCommand {
    /// List local connection profiles
    List {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Show the selected default profile
    Current {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Create a local connection profile
    Create {
        name: String,
        /// Hub HTTP(S) origin
        #[arg(long)]
        hub_url: String,
        /// Create the profile without starting its runtime
        #[arg(long)]
        disabled: bool,
    },
    /// Show one local connection profile
    Show {
        name: String,
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Change the persistent default profile
    Use { name: String },
    /// Rename a profile without changing its immutable ID
    Rename { old: String, new: String },
    /// Enable a profile
    Enable { name: String },
    /// Disable a non-default profile
    Disable { name: String },
    /// Remove a disabled profile from ordinary selection
    Remove { name: String },
    /// Permanently delete one removed profile's isolated local state
    Purge {
        name_or_id: String,
        /// Confirm permanent deletion
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum SecretAccessArg {
    /// Any live Agent Run in the Space reads it when it asks.
    Auto,
    /// A Space admin approves each Run on a card in its Channel.
    Ask,
}

impl SecretAccessArg {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretAccessArg::Auto => "auto",
            SecretAccessArg::Ask => "ask",
        }
    }
}

#[derive(Subcommand)]
pub enum Commands {
    /// Authenticate with xMatrix
    Login {
        /// Name this Machine before starting its daemon; required for a new headless login.
        #[arg(long, env = "XMATRIX_MACHINE_NAME")]
        machine_name: Option<String>,
        /// Connect this machine with the setup command copied from xMatrix: approve the
        /// terminal on that page; the machine is named after its hostname unless named already.
        #[arg(long, env = "XMATRIX_CONNECT", value_name = "SETUP_ID")]
        connect: Option<String>,
    },
    /// Remove stored credentials for the selected environment
    Logout {
        /// Remove every Hub session stored inside the selected profile
        #[arg(long)]
        all: bool,
        /// Remove sessions from every local connection profile
        #[arg(long, conflicts_with = "all")]
        all_profiles: bool,
    },
    /// Hand a Hub session to the local credential store, or read the
    /// resolved local context (used by the Desktop App)
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    /// Show current user
    Whoami,
    /// Inspect billing without purchasing or changing subscriptions
    Billing {
        #[command(subcommand)]
        command: BillingCommand,
    },
    /// Inspect or change the active Hub environment
    Env {
        #[command(subcommand)]
        command: EnvironmentCommand,
    },
    /// Manage local connection profiles
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
    /// Answer a Git credential request for this run's repository.
    ///
    /// Git invokes this; it is not meant to be run by hand. Git writes the
    /// request on stdin and reads the answer from stdout.
    #[command(name = "git-credential", hide = true)]
    GitCredential {
        /// `get`, `store`, or `erase`, as passed by Git.
        operation: String,
    },
    /// Check Hub connectivity
    Status,
    /// Read invocation diagnostics without restarting or sending a message
    Diagnose {
        /// Channel URL/ID, or a Run ID beginning with run:
        target: String,
        /// Interpret a non-prefixed ID as a Run ID
        #[arg(long)]
        run: bool,
        /// Number of recent messages to inspect for a Channel
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=100))]
        limit: u16,
        /// Inspect one exact source message instead of a recent window
        #[arg(long, conflicts_with = "run")]
        message: Option<String>,
        /// Read one sent message's commit receipt instead of invocation progress
        #[arg(long, conflicts_with_all = ["run", "message"])]
        receipt: Option<String>,
        /// List decision records, or read one exact record; requires --message
        #[arg(long, num_args = 0..=1, default_missing_value = "", requires = "message", conflicts_with_all = ["run", "receipt"])]
        decision_evidence: Option<String>,
        /// Print a safe, structured diagnostic report
        #[arg(long)]
        json: bool,
    },
    /// Update this xMatrix CLI binary from the latest release
    Update {
        /// Release metadata URL
        #[arg(
            long,
            env = "XMATRIX_RELEASE_API_URL",
            default_value = "https://xmatrix.sh/api/cli/releases/latest"
        )]
        release_api_url: String,
        /// Reinstall even when the latest version matches this binary
        #[arg(long)]
        force: bool,
    },
    /// Internal: hand this agent run to this CLI's version. The daemon starts
    /// it when a run it hosts is behind; it is not for Agents or people.
    #[command(name = "update-self", hide = true)]
    UpdateSelf,
    /// Register this machine's daemon with the login-session manager
    Setup {
        /// Choose the Machine name before starting a daemon for the signed-in owner.
        #[arg(long, global = true, env = "XMATRIX_MACHINE_NAME")]
        machine_name: Option<String>,
        #[command(subcommand)]
        command: SetupCommand,
    },
    /// List connected agents
    #[command(alias = "ls")]
    List {
        /// Emit machine-readable JSON with narrow fields including provider quota
        #[arg(long)]
        json: bool,
    },
    /// Manage agents
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// List workspace channels
    Channels {
        /// Filter by space ID
        #[arg(long)]
        space: Option<String>,
        /// Only an open project's intake: conversations its participants started
        #[arg(long)]
        intake: bool,
    },
    /// List spaces
    Spaces,
    /// Create or manage spaces
    Space {
        #[command(subcommand)]
        command: SpaceCommand,
    },
    /// Inspect or rename this Machine
    Machine {
        #[command(subcommand)]
        command: MachineCommand,
    },
    /// Inspect, install, update or configure harnesses on a Machine
    Harness {
        #[command(subcommand)]
        command: HarnessCommand,
    },
    /// Register or list local directories as workspaces
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Run or inspect the local machine daemon for chat-launched workspace tasks
    Daemon {
        #[command(subcommand)]
        command: Option<DaemonCommand>,
    },
    /// Request privileged local-daemon command execution
    Request {
        #[command(subcommand)]
        command: RequestCommand,
    },
    /// Manage your Hub secret catalog
    #[command(alias = "secrets")]
    Secret {
        #[command(subcommand)]
        command: SecretCommand,
    },
    /// Connected apps (connectors) of this Space
    Connector {
        #[command(subcommand)]
        command: ConnectorCliCommand,
    },
    /// Set, clear, or inspect the goal this agent run keeps working toward
    Goal {
        #[command(subcommand)]
        command: GoalCliCommand,
    },
    /// Send a message to a channel
    Send(SendArgs),
    /// Create, join, leave, or send channel messages
    Channel {
        #[command(subcommand)]
        command: ChannelCommand,
    },
    /// Work with channel attachments
    Attachment {
        #[command(subcommand)]
        command: AttachmentCommand,
    },
    /// Migrate data from another collaboration tool
    Migrate {
        #[command(subcommand)]
        command: MigrateCommand,
    },
    /// Show or set config
    Config {
        /// Key to show or set
        key: Option<String>,
        /// Value to set
        value: Option<String>,
    },
    /// memory-fabric: generic channel annotations primitive (raw Hub API)
    Annotation {
        #[command(subcommand)]
        command: AnnotationCommand,
    },
    /// Ask to read a Channel or Space outside this Agent Run's own Space, and
    /// let its owner approve, deny, or revoke that read-only grant
    Access {
        #[command(subcommand)]
        command: AccessCommand,
    },
    /// Pages: the Space's living documents (read, edit content, link to this conversation)
    Page {
        #[command(subcommand)]
        command: PageCommand,
    },
    /// Run the xMatrix space management runtime
    Management {
        /// Boxed: the management surface is much larger than every other command.
        #[command(subcommand)]
        command: Box<ManagementCommand>,
    },
    /// Create and manage Channel Automations
    Automation {
        #[command(subcommand)]
        command: AutomationCommand,
    },
    /// Run an external command (passthrough)
    #[command(external_subcommand)]
    External(Vec<String>),
}

#[derive(Subcommand, Debug)]
pub enum BillingCommand {
    /// Inspect Space Pro billing
    Space {
        #[command(subcommand)]
        command: SpaceBillingCommand,
    },
    /// Open the billing page; does not create a checkout or trial
    Open,
}

#[derive(Subcommand, Debug)]
pub enum SpaceBillingCommand {
    /// Show billing for an explicitly selected Space
    Status {
        #[arg(long)]
        space: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum AutomationCommand {
    /// List Automations visible in a Channel (or a managed Space)
    List {
        #[arg(long, conflicts_with = "space")]
        channel: Option<String>,
        #[arg(long, conflicts_with = "channel")]
        space: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Update an Automation without moving its Channel or changing its author
    Update {
        automation_id: String,
        #[arg(long = "version", visible_alias = "expected-version")]
        expected_version: u64,
        #[arg(long)]
        name: Option<String>,
        #[arg(long = "expression", alias = "message")]
        expression: Option<String>,
        #[arg(long = "every", alias = "interval-minutes")]
        interval_minutes: Option<u64>,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Pause an Automation, or request Human approval when required
    Pause {
        automation_id: String,
        #[arg(long = "version", visible_alias = "expected-version")]
        expected_version: u64,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Resume an Automation
    Resume {
        automation_id: String,
        #[arg(long = "version", visible_alias = "expected-version")]
        expected_version: u64,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Cancel one exact execution as its Human owner; keep the Automation schedule
    CancelExecution {
        automation_id: String,
        #[arg(long)]
        run_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete an Automation lineage
    Delete {
        automation_id: String,
        #[arg(long = "version", visible_alias = "expected-version")]
        expected_version: u64,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum ManagementCommand {
    /// Search active or archived channels across metadata, bindings, loops, and messages
    Channels {
        /// Space ID managed by this run
        #[arg(long)]
        space: String,
        /// Search query; empty lists channels
        #[arg(long, default_value = "")]
        query: String,
        /// Maximum matches
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Inspect one authoritative channel detail view
    Channel {
        /// Space ID managed by this run
        #[arg(long)]
        space: String,
        /// Stable channel ID
        #[arg(long)]
        channel: String,
        /// Number of tail messages to include
        #[arg(long, default_value_t = 50)]
        message_limit: u32,
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
}

impl ManagementCommand {
    /// The `--space` a command names, so it can be resolved to an id first.
    pub fn space_mut(&mut self) -> &mut String {
        match self {
            Self::Channels { space, .. } | Self::Channel { space, .. } => space,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn linked_pages_default_to_the_run_or_accept_an_explicit_conversation() {
        let cli = Cli::try_parse_from(["xmatrix", "page", "linked"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Page {
                command: PageCommand::Linked { conversation: None }
            })
        ));
        let cli =
            Cli::try_parse_from(["xmatrix", "page", "linked", "--conversation", "channel-id"])
                .unwrap();
        assert!(matches!(cli.command, Some(Commands::Page {
            command: PageCommand::Linked { conversation: Some(ref id) }
        }) if id == "channel-id"));
    }

    #[test]
    fn billing_readonly_commands_parse() {
        assert!(
            Cli::try_parse_from([
                "xmatrix", "billing", "space", "status", "--space", "space-1", "--json"
            ])
            .is_ok()
        );
        assert!(Cli::try_parse_from(["xmatrix", "billing", "space", "status"]).is_err());
        assert!(Cli::try_parse_from(["xmatrix", "billing", "open"]).is_ok());
    }

    #[test]
    fn list_usage_visibility_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "list"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::List { json: false })));
        let cli = Cli::try_parse_from(["xmatrix", "ls", "--json"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::List { json: true })));
    }

    #[test]
    fn billing_rejects_unbounded_usage_and_mutations() {
        for limit in ["0", "101", "-1"] {
            assert!(
                Cli::try_parse_from(["xmatrix", "billing", "ai", "usage", "--limit", limit])
                    .is_err()
            );
        }
        for action in ["checkout", "trial", "cancel", "upgrade"] {
            assert!(Cli::try_parse_from(["xmatrix", "billing", "ai", action]).is_err());
        }
    }

    #[test]
    fn machine_name_is_explicit_in_login_and_setup_and_workspace_host_is_removed() {
        Cli::command().debug_assert();
        let login = Cli::try_parse_from(["xmatrix", "login", "--machine-name", "Laptop"]).unwrap();
        assert!(
            matches!(login.command, Some(Commands::Login { machine_name: Some(name), .. }) if name == "Laptop")
        );
        let setup = Cli::try_parse_from(["xmatrix", "setup", "daemon", "--machine-name", "Laptop"])
            .unwrap();
        assert!(
            matches!(setup.command, Some(Commands::Setup { machine_name: Some(name), .. }) if name == "Laptop")
        );
        assert!(
            Cli::try_parse_from(["xmatrix", "workspace", "register", "--host", "Laptop"]).is_err()
        );
    }

    #[test]
    fn login_takes_the_setup_command_from_xmatrix() {
        let login =
            Cli::try_parse_from(["xmatrix", "login", "--connect", "0123456789abcdef"]).unwrap();
        assert!(
            matches!(login.command, Some(Commands::Login { connect: Some(id), machine_name: None }) if id == "0123456789abcdef")
        );
    }

    #[test]
    fn login_has_no_email_option() {
        assert!(Cli::try_parse_from(["xmatrix", "login", "--email", "user@example.com"]).is_err());
    }

    #[test]
    fn login_has_no_otp_option() {
        assert!(Cli::try_parse_from(["xmatrix", "login", "--otp"]).is_err());
    }

    #[test]
    fn login_has_no_code_option() {
        assert!(Cli::try_parse_from(["xmatrix", "login", "--code", "123456"]).is_err());
    }

    #[test]
    fn login_has_no_browser_option() {
        assert!(Cli::try_parse_from(["xmatrix", "login", "--browser"]).is_err());
    }

    #[test]
    fn built_in_environment_and_custom_hub_are_mutually_exclusive() {
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "--environment",
                "test",
                "--hub-url",
                "https://hub.example",
                "status",
            ])
            .is_err()
        );
    }

    #[test]
    fn environment_use_parses_the_named_target() {
        let cli = Cli::try_parse_from(["xmatrix", "env", "use", "test"])
            .expect("environment command should parse");
        assert!(matches!(
            cli.command,
            Some(Commands::Env {
                command: EnvironmentCommand::Use {
                    environment: CliEnvironmentArg::Test,
                },
            })
        ));
    }

    #[test]
    fn explicit_profile_is_global_and_conflicts_with_legacy_selectors() {
        let cli = Cli::try_parse_from(["xmatrix", "--profile", "isolated", "status"])
            .expect("profile selector should parse");
        assert_eq!(cli.profile.as_deref(), Some("isolated"));
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "--profile",
                "isolated",
                "--environment",
                "test",
                "status",
            ])
            .is_err()
        );
    }

    #[test]
    fn profile_commands_parse_mutations_and_confirmation() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "profile",
            "create",
            "isolated",
            "--hub-url",
            "https://hub.example",
            "--disabled",
        ])
        .expect("profile create should parse");
        assert!(matches!(
            cli.command,
            Some(Commands::Profile {
                command: ProfileCommand::Create {
                    name,
                    hub_url,
                    disabled: true,
                },
            }) if name == "isolated" && hub_url == "https://hub.example"
        ));
        assert!(Cli::try_parse_from(["xmatrix", "profile", "purge", "isolated"]).is_ok());
    }

    #[test]
    fn cross_profile_logout_requires_the_explicit_new_flag() {
        let cli = Cli::try_parse_from(["xmatrix", "logout", "--all-profiles"])
            .expect("cross-profile logout flag should parse");
        assert!(matches!(
            cli.command,
            Some(Commands::Logout {
                all: false,
                all_profiles: true,
            })
        ));
        assert!(Cli::try_parse_from(["xmatrix", "logout", "--all", "--all-profiles"]).is_err());
    }

    #[test]
    fn automation_cancel_requires_an_exact_execution() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "automation",
            "cancel-execution",
            "automation-1",
            "--run-id",
            "run:scheduled:old",
            "--json",
        ])
        .unwrap();
        assert!(matches!(cli.command, Some(Commands::Automation {
            command: AutomationCommand::CancelExecution { automation_id, run_id, json: true }
        }) if automation_id == "automation-1" && run_id == "run:scheduled:old"));
        assert!(
            Cli::try_parse_from(["xmatrix", "automation", "cancel-execution", "automation-1"])
                .is_err()
        );
    }

    #[test]
    fn automation_pause_parses_cas_and_reason() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "automation",
            "pause",
            "automation-1",
            "--version",
            "7",
            "--reason",
            "no longer needed",
        ])
        .expect("Automation pause should parse");
        let Some(Commands::Automation {
            command:
                AutomationCommand::Pause {
                    automation_id,
                    expected_version,
                    reason,
                    json: _,
                },
        }) = cli.command
        else {
            panic!("expected Automation pause");
        };
        assert_eq!(automation_id, "automation-1");
        assert_eq!(expected_version, 7);
        assert_eq!(reason.as_deref(), Some("no longer needed"));
    }

    #[test]
    fn workspace_bind_command_is_not_available() {
        assert!(
            Cli::try_parse_from(["xmatrix", "workspace", "bind", "repo", "channel-1"]).is_err()
        );
    }

    #[test]
    fn machine_rename_takes_one_name_and_rotation_is_gone() {
        assert!(Cli::try_parse_from(["xmatrix", "machine", "rename", "Build box"]).is_ok());
        assert!(Cli::try_parse_from(["xmatrix", "machine", "rename"]).is_err());
        assert!(Cli::try_parse_from(["xmatrix", "machine", "rotate", "--yes"]).is_err());
    }

    #[test]
    fn machine_auto_assign_takes_on_or_off() {
        let cli = Cli::try_parse_from(["xmatrix", "machine", "auto-assign", "off"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Machine {
                command: MachineCommand::AutoAssign { state: OnOff::Off }
            })
        ));
        assert!(Cli::try_parse_from(["xmatrix", "machine", "auto-assign"]).is_err());
        assert!(Cli::try_parse_from(["xmatrix", "machine", "auto-assign", "maybe"]).is_err());
    }

    #[test]
    fn machine_supervisor_start_daemon_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "machine", "supervisor", "start-daemon"])
            .expect("machine supervisor start-daemon should parse");
        let Some(Commands::Machine {
            command:
                MachineCommand::Supervisor {
                    command: MachineSupervisorCommand::StartDaemon,
                },
        }) = cli.command
        else {
            panic!("expected machine supervisor start-daemon command");
        };
    }

    #[test]
    fn machine_supervisor_bridge_fence_requires_exact_transaction_fields() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "machine",
            "supervisor",
            "bridge-preflight",
            "--artifact-sha256",
            &"a".repeat(64),
            "--transaction-id",
            "tx-1",
            "--transaction-nonce",
            &"n".repeat(32),
            "--source-epoch",
            "7",
            "--fence",
        ])
        .expect("Bridge fence should parse");
        assert!(matches!(
            cli.command,
            Some(Commands::Machine {
                command: MachineCommand::Supervisor {
                    command: MachineSupervisorCommand::BridgePreflight {
                        fence: true,
                        source_epoch: Some(7),
                        ..
                    }
                }
            })
        ));
    }

    #[test]
    fn channel_management_read_parses() {
        let cli =
            Cli::try_parse_from(["xmatrix", "channel", "management-read", "channel-1", "off"])
                .expect("channel management-read should parse");
        let Some(Commands::Channel {
            command:
                ChannelCommand::ManagementRead {
                    channel_id,
                    state: ManagementReadState::Off,
                },
        }) = cli.command
        else {
            panic!("expected channel management-read command");
        };
        assert_eq!(channel_id, "channel-1");
    }

    #[test]
    fn daemon_starts_without_subcommand() {
        let cli = Cli::try_parse_from(["xmatrix", "daemon"]).expect("daemon should parse");
        let Some(Commands::Daemon { command }) = cli.command else {
            panic!("expected daemon command");
        };
        assert!(command.is_none());
    }

    #[test]
    fn request_secret_add_parses_metadata_without_command() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "request",
            "secret-add",
            "api-dev-key",
            "--env",
            "PROVIDER_API_KEY",
            "--reason",
            "call the model API",
            "--description",
            "Local model API experiments",
        ])
        .expect("request secret-add should parse");
        let Some(Commands::Request {
            command:
                RequestCommand::SecretAdd {
                    secret_ref,
                    env,
                    reason,
                    description,
                    command,
                    ..
                },
        }) = cli.command
        else {
            panic!("expected request secret-add command");
        };
        assert_eq!(secret_ref, "api-dev-key");
        assert_eq!(env.as_deref(), Some("PROVIDER_API_KEY"));
        assert_eq!(reason.as_deref(), Some("call the model API"));
        assert_eq!(description.as_deref(), Some("Local model API experiments"));
        assert!(command.is_empty());
    }

    #[test]
    fn request_secret_add_parses_trailing_command_without_env() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "request",
            "secret-add",
            "github-token",
            "--",
            "gh",
            "pr",
            "view",
            "--json",
            "url",
        ])
        .expect("request secret-add should parse a trailing command");
        let Some(Commands::Request {
            command:
                RequestCommand::SecretAdd {
                    env, json, command, ..
                },
        }) = cli.command
        else {
            panic!("expected request secret-add command");
        };
        assert_eq!(env, None, "a saved secret keeps its own environment name");
        assert!(!json, "--json after -- belongs to the requested command");
        assert_eq!(command, vec!["gh", "pr", "view", "--json", "url"]);
    }

    #[test]
    fn request_secrets_parses_json_flag() {
        let cli = Cli::try_parse_from(["xmatrix", "request", "secrets", "--json"])
            .expect("request secrets should parse");
        let Some(Commands::Request {
            command: RequestCommand::Secrets { json },
        }) = cli.command
        else {
            panic!("expected request secrets command");
        };
        assert!(json);
    }

    #[test]
    fn secret_set_parses_space_access_and_stdin_value() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "secret",
            "set",
            "api-dev-key",
            "--env",
            "PROVIDER_API_KEY",
            "--description",
            "Local model API experiments",
            "--access",
            "auto",
            "--space",
            "space-1",
            "--value-stdin",
        ])
        .expect("secret set should parse");
        let Some(Commands::Secret {
            command:
                SecretCommand::Set {
                    secret_ref,
                    value,
                    value_stdin,
                    env_name,
                    description,
                    access,
                    space,
                },
        }) = cli.command
        else {
            panic!("expected secret set command");
        };
        assert_eq!(secret_ref, "api-dev-key");
        assert_eq!(value, None);
        assert!(value_stdin);
        assert_eq!(env_name.as_deref(), Some("PROVIDER_API_KEY"));
        assert_eq!(description.as_deref(), Some("Local model API experiments"));
        assert_eq!(access, Some(SecretAccessArg::Auto));
        assert_eq!(space.as_deref(), Some("space-1"));
    }

    #[test]
    fn secret_list_and_delete_parse() {
        let cli = Cli::try_parse_from(["xmatrix", "secrets", "list", "--json"])
            .expect("secret list alias should parse");
        let Some(Commands::Secret {
            command: SecretCommand::List { space, json },
        }) = cli.command
        else {
            panic!("expected secret list command");
        };
        assert!(json);
        assert_eq!(space, None, "inside an Agent Run the Space is its own");

        let cli = Cli::try_parse_from([
            "xmatrix",
            "secret",
            "delete",
            "api-dev-key",
            "--space",
            "space-1",
        ])
        .expect("secret delete should parse");
        let Some(Commands::Secret {
            command: SecretCommand::Delete { secret_ref, space },
        }) = cli.command
        else {
            panic!("expected secret delete command");
        };
        assert_eq!(secret_ref, "api-dev-key");
        assert_eq!(space, "space-1");
        assert!(
            Cli::try_parse_from(["xmatrix", "secret", "delete", "api-dev-key"]).is_err(),
            "deleting names the Space"
        );
    }

    #[test]
    fn channel_worktree_command_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "channel", "worktree", "channel-1", "off"])
            .expect("channel worktree off should parse");
        let Some(Commands::Channel {
            command: ChannelCommand::Worktree { channel_id, state },
        }) = cli.command
        else {
            panic!("expected channel worktree command");
        };
        assert_eq!(channel_id, "channel-1");
        assert_eq!(state, WorktreeState::Off);

        let cli = Cli::try_parse_from(["xmatrix", "channel", "worktree", "channel-1", "inherit"])
            .expect("channel worktree inherit should parse");
        let Some(Commands::Channel {
            command: ChannelCommand::Worktree { state, .. },
        }) = cli.command
        else {
            panic!("expected channel worktree command");
        };
        assert_eq!(state, WorktreeState::Inherit);

        assert!(
            Cli::try_parse_from(["xmatrix", "channel", "worktree", "channel-1", "maybe"]).is_err()
        );
    }

    #[test]
    fn channel_visibility_command_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "channel", "visibility", "channel-1", "private"])
            .expect("channel visibility private should parse");
        let Some(Commands::Channel {
            command: ChannelCommand::Visibility { channel_id, state },
        }) = cli.command
        else {
            panic!("expected channel visibility command");
        };
        assert_eq!(channel_id, "channel-1");
        assert_eq!(state, ChannelVisibilityState::Private);

        let cli = Cli::try_parse_from(["xmatrix", "channel", "visibility", "channel-1", "public"])
            .expect("channel visibility public should parse");
        let Some(Commands::Channel {
            command: ChannelCommand::Visibility { state, .. },
        }) = cli.command
        else {
            panic!("expected channel visibility command");
        };
        assert_eq!(state, ChannelVisibilityState::Public);
    }

    #[test]
    fn channel_transfer_requires_one_explicit_ack_role() {
        assert!(
            Cli::try_parse_from(["xmatrix", "channel", "move", "tree", "--space", "target"])
                .is_ok()
        );
        for role in ["outbound", "inbound"] {
            assert!(
                Cli::try_parse_from([
                    "xmatrix",
                    "channel",
                    "move",
                    "tree",
                    "--proposal",
                    "proposal",
                    "--source-space",
                    "source",
                    "--ack",
                    role
                ])
                .is_ok()
            );
        }
        for args in [
            vec![
                "--ack",
                "both",
                "--proposal",
                "proposal",
                "--source-space",
                "source",
            ],
            vec!["--ack", "outbound"],
            vec!["--proposal", "proposal"],
            vec![
                "--space",
                "target",
                "--ack",
                "inbound",
                "--proposal",
                "proposal",
                "--source-space",
                "source",
            ],
        ] {
            assert!(
                Cli::try_parse_from(
                    ["xmatrix", "channel", "move", "tree"]
                        .into_iter()
                        .chain(args)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn channel_move_only_moves_between_spaces() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "channel",
            "move",
            "channel-1",
            "--space",
            "space-2",
        ])
        .expect("channel move should parse");
        let Some(Commands::Channel {
            command: ChannelCommand::Move {
                channel_id, space, ..
            },
        }) = cli.command
        else {
            panic!("expected channel move command");
        };
        assert_eq!(channel_id, "channel-1");
        assert_eq!(space.as_deref(), Some("space-2"));
        for args in [vec!["--parent", "parent-1"], vec!["--root"], vec![]] {
            assert!(
                Cli::try_parse_from(
                    ["xmatrix", "channel", "move", "channel-1"]
                        .into_iter()
                        .chain(args)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn daemon_doctor_cleanup_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "daemon", "doctor", "--cleanup"])
            .expect("daemon doctor should parse");
        let Some(Commands::Daemon {
            command: Some(DaemonCommand::Doctor { cleanup }),
        }) = cli.command
        else {
            panic!("expected daemon doctor command");
        };
        assert!(cleanup);
    }

    #[test]
    fn daemon_sync_session_parses() {
        let cli = Cli::try_parse_from(["xmatrix", "daemon", "sync-session"])
            .expect("daemon sync-session should parse");
        assert!(matches!(
            cli.command,
            Some(Commands::Daemon {
                command: Some(DaemonCommand::SyncSession),
            })
        ));
    }

    #[test]
    fn daemon_profile_control_commands_parse_with_global_selector() {
        for (name, expected) in [
            ("start-profile", "start"),
            ("stop-profile", "stop"),
            ("restart-profile", "restart"),
        ] {
            let cli = Cli::try_parse_from(["xmatrix", "daemon", name, "--profile", "test"])
                .expect("daemon profile control should parse");
            assert_eq!(cli.profile.as_deref(), Some("test"));
            let Some(Commands::Daemon {
                command: Some(command),
            }) = cli.command
            else {
                panic!("expected daemon profile control command");
            };
            assert!(matches!(
                (expected, command),
                ("start", DaemonCommand::StartProfile)
                    | ("stop", DaemonCommand::StopProfile)
                    | ("restart", DaemonCommand::RestartProfile)
            ));
        }
    }

    #[test]
    fn send_accepts_working_directory_in_agent_new_mention() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "send",
            "channel-1",
            "@codex:new:C:\\Users\\dev\\Projects\\xmatrix",
            "inspect",
        ])
        .expect("send should parse workspace");
        let Some(Commands::Send(SendArgs {
            channel_id,
            stdin,
            escape_newlines,
            message,
            ..
        })) = cli.command
        else {
            panic!("expected send command");
        };
        assert_eq!(channel_id, "channel-1");
        assert!(!stdin);
        assert!(!escape_newlines);
        assert_eq!(
            message,
            vec!["@codex:new:C:\\Users\\dev\\Projects\\xmatrix", "inspect"]
        );
    }

    #[test]
    fn channel_send_accepts_working_directory_in_agent_new_mention() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "channel",
            "send",
            "channel-1",
            "@claude:new:C:\\Users\\dev\\Projects\\xmatrix",
            "review",
        ])
        .expect("channel send should parse workspace");
        let Some(Commands::Channel {
            command:
                ChannelCommand::Send(SendArgs {
                    channel_id,
                    stdin,
                    escape_newlines,
                    message,
                    ..
                }),
        }) = cli.command
        else {
            panic!("expected channel send command");
        };
        assert_eq!(channel_id, "channel-1");
        assert!(!stdin);
        assert!(!escape_newlines);
        assert_eq!(
            message,
            vec!["@claude:new:C:\\Users\\dev\\Projects\\xmatrix", "review"]
        );
    }

    #[test]
    fn attachment_fetch_parses_signed_url() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "attachment",
            "fetch",
            "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=abc",
        ])
        .expect("attachment fetch should parse");
        let Some(Commands::Attachment {
            command: AttachmentCommand::Fetch { url, output },
        }) = cli.command
        else {
            panic!("expected attachment fetch command");
        };
        assert_eq!(
            url,
            "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=abc"
        );
        assert_eq!(output, None);
    }

    #[test]
    fn send_parses_multiline_input_flags() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "send",
            "channel-1",
            "--stdin",
            "--escape-newlines",
            "Heading\\n\\nbody",
        ])
        .expect("send should parse multiline flags");
        let Some(Commands::Send(SendArgs {
            stdin,
            escape_newlines,
            message,
            ..
        })) = cli.command
        else {
            panic!("expected send command");
        };
        assert!(stdin);
        assert!(escape_newlines);
        assert_eq!(message, vec!["Heading\\n\\nbody"]);
    }

    #[test]
    fn metadata_history_and_restore_have_bounded_explicit_revision_arguments() {
        assert!(
            Cli::try_parse_from(["xmatrix", "channel", "history", "c", "--authoritative"]).is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "metadata-history",
                "c",
                "--revision",
                "0"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "metadata-history",
                "c",
                "--input",
                "input-id"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "metadata-history",
                "c",
                "--limit",
                "101"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "metadata-restore",
                "c",
                "--revision",
                "0"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "metadata-restore",
                "c",
                "--revision",
                "0",
                "--expected-revision",
                "2"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "channel",
                "about",
                "c",
                "--summary",
                "text",
                "--expected-revision",
                "2"
            ])
            .is_ok()
        );
    }

    #[test]
    fn channel_about_reads_summary_and_name_from_files() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "channel",
            "about",
            "channel-1",
            "--summary-file",
            "about.md",
            "--name-file",
            "name.txt",
            "--through",
            "m-9",
        ])
        .expect("about should accept file inputs");
        let Some(Commands::Channel {
            command:
                ChannelCommand::About {
                    summary,
                    summary_file,
                    name,
                    name_file,
                    through,
                    ..
                },
        }) = cli.command
        else {
            panic!("expected channel about command");
        };
        assert_eq!(summary, None);
        assert_eq!(summary_file, Some(PathBuf::from("about.md")));
        assert_eq!(name, None);
        assert_eq!(name_file, Some(PathBuf::from("name.txt")));
        assert_eq!(through.as_deref(), Some("m-9"));
    }

    #[test]
    fn channel_about_needs_exactly_one_source_per_field() {
        let about = |extra: &[&str]| {
            let mut argv = vec!["xmatrix", "channel", "about", "channel-1"];
            argv.extend_from_slice(extra);
            Cli::try_parse_from(argv)
        };
        assert!(about(&["--summary", "text"]).is_ok());
        assert!(about(&[]).is_err());
        assert!(about(&["--summary", "text", "--summary-file", "a.md"]).is_err());
        assert!(about(&["--summary", "text", "--name", "n", "--name-file", "n.txt"]).is_err());
    }
}

#[derive(Subcommand)]
pub enum MigrateCommand {
    /// Import a Slack export zip or expanded export directory
    Slack {
        /// Path to a Slack export .zip file or extracted export directory.
        /// Omit this to migrate the current Slack workspace via Web API.
        export_path: Option<PathBuf>,
        /// Slack bot or user token. Defaults to SLACK_BOT_TOKEN.
        #[arg(long, env = "SLACK_BOT_TOKEN")]
        slack_token: Option<String>,
        /// Name for the created xMatrix space
        #[arg(long)]
        space_name: Option<String>,
        /// Import archived Slack channels too
        #[arg(long)]
        include_archived: bool,
        /// Maximum messages to import per channel; 0 means all messages
        #[arg(long, default_value_t = 0)]
        max_messages_per_channel: usize,
        /// History retention mode: free imports recent Slack-style history, all imports full history
        #[arg(long, value_enum, default_value_t = MigrationHistoryMode::Free)]
        history: MigrationHistoryMode,
        /// Parse and summarize without writing to the Hub
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Clone, Debug, ValueEnum)]
pub enum MigrationHistoryMode {
    Free,
    All,
}

#[derive(Subcommand)]
pub enum WorkspaceCommand {
    /// Register the current or specified directory for chat-launched tasks
    Register {
        /// Directory to register. Defaults to the current directory.
        #[arg(long)]
        path: Option<PathBuf>,
        /// Stable display name shown in chat and workspace lists.
        #[arg(long)]
        name: Option<String>,
    },
    /// List workspaces registered by the current user
    List,
    /// Unregister a workspace by absolute path or unambiguous display name
    Unregister { workspace: String },
}

#[derive(Subcommand)]
pub enum MachineCommand {
    /// Show this Machine's id, what it is derived from, and legacy ids awaiting adoption
    Identity,
    /// Run machine-level supervisor helpers
    Supervisor {
        #[command(subcommand)]
        command: MachineSupervisorCommand,
    },
    /// Rename this Machine; the name is how people and Agents address it
    Rename {
        /// New name, unique among your Machines (case-insensitive)
        name: String,
    },
    /// Let automatic assignment place work on this Machine, or keep it out:
    /// off, Agents start here only when someone names it (`machine:<name>`)
    AutoAssign { state: OnOff },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum OnOff {
    On,
    Off,
}

#[derive(Subcommand)]
pub enum MachineSupervisorCommand {
    /// Start the user daemon from this managed supervisor binary and exit
    StartDaemon,
    /// Verify or install the one-time empty-set Bridge migration fence
    BridgePreflight {
        #[arg(long)]
        artifact_sha256: String,
        #[arg(long)]
        transaction_id: String,
        #[arg(long)]
        transaction_nonce: String,
        #[arg(long)]
        source_epoch: Option<u64>,
        #[arg(long)]
        fence: bool,
    },
}

#[derive(Subcommand)]
pub enum DaemonCommand {
    /// Inspect local daemon broker state and tracked child runs
    Doctor {
        /// Remove registry rows for child PIDs that no longer exist
        #[arg(long)]
        cleanup: bool,
    },
    /// Reload the saved login into the running daemon without restarting agents
    SyncSession,
    /// Show the admitted runtime state for the selected local profile
    ProfileStatus {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Start the selected enabled local profile runtime
    StartProfile,
    /// Stop the selected local profile runtime without changing the registry
    StopProfile,
    /// Restart only the selected local profile runtime
    RestartProfile,
    /// Summarize per-harness wake metrics: first response time, first-turn
    /// input tokens and compactions of woken Runs versus cold starts
    WakeMetrics {
        /// Only this harness (claude_code, codex, grok, ...)
        #[arg(long)]
        harness: Option<String>,
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum RequestCommand {
    /// List this Space's secrets and which ones this Agent may read now
    Secrets {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Ask a Space admin, on a card in this Channel, for a secret this Agent may not read yet
    ///
    /// For a secret the Space already holds, an admin lets this Agent use it
    /// with one click; for a new one, the admin types the value on the card. It
    /// is stored in the Space, never shown in chat. Append `-- <cmd> [args...]`
    /// to run one command with it as soon as it is answered.
    SecretAdd {
        /// Secret alias, for example `api-dev-key`.
        secret_ref: String,
        /// Environment variable name for a secret the Space does not hold yet.
        #[arg(long)]
        env: Option<String>,
        /// Why this agent needs the secret.
        #[arg(long)]
        reason: Option<String>,
        /// Description shown with the alias.
        #[arg(long)]
        description: Option<String>,
        /// Working directory for the optional follow-up command. Defaults to the current directory.
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Print machine-readable JSON instead of replaying command output.
        #[arg(long)]
        json: bool,
        /// Optional command to run with the secret once answered; must follow `--`.
        #[arg(last = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum SecretCommand {
    /// List a Space's secrets; values are never printed. Inside an Agent Run,
    /// without --space: its Space's secrets and which it may read now.
    List {
        /// The Space whose secrets to list.
        #[arg(long)]
        space: Option<String>,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Save a secret in a Space (Space admins). Inside an Agent Run, without
    /// --space: save a credential it holds into its Space.
    Set {
        /// Secret alias.
        secret_ref: String,
        /// Secret value. Prefer --value-stdin to avoid shell history.
        #[arg(long, conflicts_with = "value_stdin")]
        value: Option<String>,
        /// Read the secret value from stdin.
        #[arg(long, conflicts_with = "value")]
        value_stdin: bool,
        /// Environment variable name an Agent reads it as.
        #[arg(long = "env")]
        env_name: Option<String>,
        /// Description shown with the alias.
        #[arg(long)]
        description: Option<String>,
        /// How Agent Runs get it: auto, or ask a Space admin each time.
        #[arg(long, value_enum)]
        access: Option<SecretAccessArg>,
        /// The Space to save it in.
        #[arg(long)]
        space: Option<String>,
    },
    /// Delete a Space's secret (Space admins).
    Delete {
        /// Secret alias.
        secret_ref: String,
        /// The Space it belongs to.
        #[arg(long)]
        space: String,
    },
    /// Inside an Agent Run: run a command with secrets of its Space in its environment
    Exec {
        /// Secret to pass, as `<alias>` or `<alias>=<ENV_NAME>` (repeatable; every secret it may read now when omitted).
        /// One it may not read yet is asked for on a card in its Channel first.
        #[arg(long = "secret")]
        secrets: Vec<String>,
        /// The command and its arguments
        #[arg(num_args = 1.., required = true, allow_hyphen_values = true, trailing_var_arg = true)]
        command: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum ConnectorCliCommand {
    /// Serve this Space's connector actions as MCP tools over stdio, for the
    /// harness an Agent Run drives (it is configured automatically)
    Mcp,
}

#[derive(Subcommand)]
pub enum GoalCliCommand {
    /// Set the completion condition this run keeps working toward
    Set {
        /// The condition, e.g. "every call site compiles and `npm test` exits 0".
        /// Accepted as one quoted argument or as trailing words.
        #[arg(required = true, num_args = 1..)]
        condition: Vec<String>,
    },
    /// Clear the active goal without waiting for its condition
    Clear,
    /// Show the goal this run is currently working toward
    Status {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum AgentCommand {
    /// List the Agents in a Space
    #[command(alias = "ls")]
    List {
        #[arg(long)]
        space: String,
    },
    /// Add an Agent that runs a harness on this machine to a Space
    Add {
        /// Harness preset id, for example codex or claude
        harness: String,
        /// Space the Agent joins
        #[arg(long)]
        space: String,
        /// Display name. Defaults to the harness id.
        #[arg(long)]
        name: Option<String>,
        /// Runtime command. Defaults to the harness preset's runtime.
        #[arg(long)]
        runtime: Option<String>,
        /// Runtime argument. Repeat for multiple args.
        #[arg(long = "arg", allow_hyphen_values = true)]
        args: Vec<String>,
        /// Directory its Runs start in by default. It is registered as a Workspace
        /// on this machine first when it is not one yet.
        #[arg(long)]
        workspace: Option<PathBuf>,
    },
    /// Show one Agent's Space configuration and access
    Show {
        /// Harness id of the Agent
        harness: String,
        #[arg(long)]
        space: String,
        /// Owner user id. Defaults to you.
        #[arg(long)]
        owner: Option<String>,
        /// Machine id. Defaults to this machine.
        #[arg(long)]
        machine: Option<String>,
        /// Include safe Space connector status and revision summaries
        #[arg(long)]
        connections: bool,
    },
    /// Remove an Agent from a Space
    #[command(alias = "rm")]
    Remove {
        /// Harness id of the Agent
        harness: String,
        #[arg(long)]
        space: String,
        /// Owner user id. Defaults to you.
        #[arg(long)]
        owner: Option<String>,
        /// Machine id. Defaults to this machine.
        #[arg(long)]
        machine: Option<String>,
    },
    /// Disable an Agent in a Space: its running work there stops and it takes
    /// no new work there until enabled. Its owner or a Space owner/admin
    Disable {
        /// Harness id of the Agent
        harness: String,
        #[arg(long)]
        space: String,
        /// Owner user id. Defaults to you.
        #[arg(long)]
        owner: Option<String>,
        /// Machine id. Defaults to this machine.
        #[arg(long)]
        machine: Option<String>,
    },
    /// Enable a disabled Agent in a Space again
    Enable {
        /// Harness id of the Agent
        harness: String,
        #[arg(long)]
        space: String,
        /// Owner user id. Defaults to you.
        #[arg(long)]
        owner: Option<String>,
        /// Machine id. Defaults to this machine.
        #[arg(long)]
        machine: Option<String>,
    },
    /// Discover known local agent installations and classic workspaces
    Discover {
        /// Limit discovery to one preset id, for example codex or claude.
        #[arg(long)]
        preset: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum ChannelCommand {
    /// Create a channel; you are its first member
    Create {
        /// Space ID. An Agent Run creates in its own Space; a person names one.
        #[arg(long)]
        space: Option<String>,
        /// Channel mode: open or closed
        #[arg(long, default_value = "open")]
        mode: String,
        /// Channel topic shown with the channel. The Summary itself is maintained by Jev.
        #[arg(long = "topic", alias = "summary")]
        summary: Option<String>,
        /// Optional channel name. Without one, the conversation is named from
        /// its first message, and that message may start an Agent.
        channel_name: Vec<String>,
    },
    /// Edit a message you sent
    EditMessage {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Message ID to edit
        message_id: String,
        /// Read the full new body from stdin. Use this for multi-line Markdown.
        #[arg(long)]
        stdin: bool,
        /// New message body
        message: Vec<String>,
    },
    /// Add your reaction to a message, or remove it if you already reacted with that emoji
    React {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Message ID to react to
        message_id: String,
        /// Emoji to toggle, for example 👍
        emoji: String,
    },
    /// Delete (recall) a message you sent
    DeleteMessage {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Message ID to delete
        message_id: String,
        /// Remove the message permanently instead of leaving a recalled placeholder
        #[arg(long)]
        permanent: bool,
    },
    /// Join an existing channel under your user name
    Join {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Your display name for this channel
        #[arg(long, required = true)]
        name: String,
    },
    /// Leave a channel
    Leave {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
    },
    /// Rename a channel
    Rename {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// New channel name
        #[arg(required = true)]
        name: Vec<String>,
    },
    /// Replace a channel's About summary (the channel's own About session only).
    /// For non-ASCII text on Windows, prefer --summary-file and --name-file:
    /// UTF-8 files never pass through the shell's code page.
    About {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// The new About summary
        #[arg(
            long,
            required_unless_present = "summary_file",
            conflicts_with = "summary_file"
        )]
        summary: Option<String>,
        /// Read the new About summary from a UTF-8 file
        #[arg(long, value_name = "PATH")]
        summary_file: Option<PathBuf>,
        /// Name a channel nobody has named yet
        #[arg(long, conflicts_with = "name_file")]
        name: Option<String>,
        /// Read the name for a channel nobody has named yet from a UTF-8 file
        #[arg(long, value_name = "PATH")]
        name_file: Option<PathBuf>,
        /// The newest message the summary covers
        #[arg(long)]
        through: Option<String>,
        /// Revision printed by the authoritative history read
        #[arg(long)]
        expected_revision: Option<u64>,
    },
    /// Read immutable title / About revisions and their recorded input
    MetadataHistory {
        channel_id: String,
        #[arg(long)]
        before_revision: Option<u64>,
        #[arg(long, conflicts_with_all = ["before_revision", "input"])]
        revision: Option<u64>,
        /// Inspect one input id listed in a revision's source
        #[arg(long, conflicts_with = "before_revision")]
        input: Option<String>,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    /// Restore a title / About by appending a new revision
    MetadataRestore {
        channel_id: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        expected_revision: u64,
    },
    /// Move a channel to another Space; human admins of both Spaces confirm it
    Move {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Destination Space ID; creates a proposal
        #[arg(long, required_unless_present = "ack", conflicts_with = "ack")]
        space: Option<String>,
        /// Existing proposal to acknowledge (human sessions only)
        #[arg(long, requires_all = ["ack", "source_space"])]
        proposal: Option<String>,
        /// Confirm exactly one role; never confirms both in one invocation
        #[arg(long, value_parser = ["outbound", "inbound"], requires_all = ["proposal", "source_space"])]
        ack: Option<String>,
        /// Source Space ID printed when the proposal was created
        #[arg(long, requires = "proposal")]
        source_space: Option<String>,
    },
    /// Change a channel between public and private visibility
    Visibility {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Desired channel visibility
        state: ChannelVisibilityState,
    },
    /// Enable or disable worktree isolation for a channel
    Worktree {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Desired worktree isolation state
        state: WorktreeState,
    },
    /// Control whether the management assistant can read this channel
    ManagementRead {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Read setting for the management assistant
        state: ManagementReadState,
    },
    /// Send a message to a channel
    Send(SendArgs),
    /// Show all available message history for a channel
    #[command(alias = "messages")]
    History {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,

        /// Bypass the daemon cache and record About input at the Hub
        #[arg(long)]
        authoritative: bool,
    },
    /// Open a simple line-based channel chat with manual refresh
    Chat {
        /// Channel ID or xmatrix.sh channel URL
        channel_id: String,
        /// Number of recent messages to load on start and /history
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ChannelVisibilityState {
    Public,
    Private,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum WorktreeState {
    On,
    Off,
    Inherit,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ManagementReadState {
    /// The assistant can read messages in this channel
    On,
    /// The assistant can see activity only, not message text
    Activity,
    /// The assistant cannot read this channel
    Off,
    /// Use the space default
    Inherit,
}

#[derive(Subcommand)]
pub enum AttachmentCommand {
    /// Download a signed channel image URL to a local file on demand
    Fetch {
        /// Signed attachment URL from an xMatrix channel image reference
        url: String,
        /// Optional output file path. Defaults to a temp-file cache.
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
pub enum SpaceCommand {
    /// Read the repositories and registered directories an Agent can be launched with in a Space
    LaunchTargets {
        /// Space ID. Defaults to the Space of this Run's conversation.
        space_id: Option<String>,
    },
    /// Create a team space
    Create {
        /// Team space name
        #[arg(required = true)]
        name: Vec<String>,
    },
    /// Rename a team space
    Rename {
        /// Space ID
        space_id: String,
        /// New name
        #[arg(required = true)]
        name: Vec<String>,
    },
    /// Delete a team space; its owner can restore it for 7 days
    Delete {
        /// Space ID
        space_id: String,
    },
    /// Restore a team space you deleted before it is purged
    Restore {
        /// Space ID
        space_id: String,
    },
    /// List the team spaces you deleted that can still be restored
    Deletions,
    /// Add or update a team space member
    AddMember {
        /// Space ID
        space_id: String,
        /// Member user ID
        user_id: String,
        /// Member role: admin, member, or viewer
        #[arg(long, default_value = "member")]
        role: String,
        /// Member email
        #[arg(long)]
        email: Option<String>,
        /// Member display name
        #[arg(long)]
        name: Option<String>,
    },
    /// Remove a team space member
    RemoveMember {
        /// Space ID
        space_id: String,
        /// Member user ID
        user_id: String,
    },
}

#[derive(Subcommand)]
pub enum AnnotationCommand {
    /// Create an annotation on a channel target
    Create {
        /// Channel ID
        channel_id: String,
        /// Namespace (e.g. xmem.canonical.v1, xmem.candidate.v1, or any agent-defined)
        #[arg(long)]
        namespace: String,
        /// Target kind: channel | message | message_range
        #[arg(long, default_value = "channel")]
        target_kind: String,
        /// Message ID (required when --target-kind=message)
        #[arg(long)]
        message_id: Option<String>,
        /// Start sequence (required when --target-kind=message_range)
        #[arg(long)]
        start_sequence: Option<i64>,
        /// End sequence (required when --target-kind=message_range)
        #[arg(long)]
        end_sequence: Option<i64>,
        /// Inline JSON payload (mutually exclusive with --payload-file / -)
        #[arg(long = "payload", short = 'p')]
        payload: Option<String>,
        /// Path to a JSON payload file
        #[arg(long = "payload-file", short = 'f')]
        payload_file: Option<PathBuf>,
        /// Read JSON payload from stdin
        #[arg(long = "payload-stdin")]
        payload_stdin: bool,
    },
    /// List annotations on a channel
    #[command(alias = "ls")]
    List {
        /// Channel ID
        channel_id: String,
        /// Filter by namespace
        #[arg(long)]
        namespace: Option<String>,
        /// Filter by target kind
        #[arg(long)]
        target_kind: Option<String>,
        /// Filter by target message id (implies target_kind=message)
        #[arg(long)]
        message_id: Option<String>,
        /// Only return annotations created strictly after this ISO timestamp
        #[arg(long)]
        after_created_at: Option<String>,
        /// Output raw JSON instead of pretty table
        #[arg(long)]
        json: bool,
    },
    /// Delete an annotation by id
    Delete {
        /// Channel ID
        channel_id: String,
        /// Annotation ID
        annotation_id: String,
    },
}

#[derive(Subcommand)]
pub enum AccessCommand {
    /// (Agent Run) Ask this Run's owner to let it read a Channel in another
    /// Space: read-only, for this Run only, for at most 24 hours
    Request {
        /// Channel ID or its exact-id link (`.../channels/<name>--<id>`)
        channel_id: String,
        /// Ask for the Channel's whole Space instead of the Channel and its threads
        #[arg(long = "whole-space")]
        whole_space: bool,
        /// Why the Run needs to read it; shown to the owner
        #[arg(long)]
        reason: Option<String>,
        /// Return after asking instead of waiting for the owner's decision
        #[arg(long = "no-wait")]
        no_wait: bool,
        /// Seconds to wait for the decision
        #[arg(long, default_value_t = 600)]
        timeout: u64,
    },
    /// Show a grant's state
    Status {
        /// Grant reference `<space-id>/<grant-id>`
        grant: String,
    },
    /// (Owner) Approve a pending grant
    Approve {
        /// Grant reference `<space-id>/<grant-id>`
        grant: String,
        /// Narrow a whole-Space request to the Channel it named
        #[arg(long = "channel-only")]
        channel_only: bool,
    },
    /// (Owner) Deny a pending grant
    Deny {
        /// Grant reference `<space-id>/<grant-id>`
        grant: String,
    },
    /// (Owner) End an approved grant now
    Revoke {
        /// Grant reference `<space-id>/<grant-id>`
        grant: String,
    },
}

#[derive(Subcommand)]
pub enum PageCommand {
    /// Read the pages linked to this conversation, on demand
    Linked {
        /// Conversation ID (defaults to this Run's conversation)
        #[arg(long)]
        conversation: Option<String>,
    },
    /// Show the page tree you can read
    #[command(alias = "ls")]
    Tree {
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Print a page as markdown with its revision header
    Read {
        /// Page ID
        page: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
        /// Read an older revision
        #[arg(long)]
        revision: Option<u64>,
        /// Print only what changed since a revision you read: its revisions and a diff
        #[arg(long, conflicts_with = "revision")]
        since: Option<u64>,
        /// Heading slug you are reading (recorded as a link from this conversation)
        #[arg(long)]
        block: Option<String>,
        /// Do not record a link from this conversation
        #[arg(long = "no-link")]
        no_link: bool,
    },
    /// Replace a page's markdown, based on the revision you read
    Edit {
        /// Page ID
        page: String,
        /// The revision your edit is based on (from `xmatrix page read`)
        #[arg(long = "base")]
        base: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
        /// New markdown
        #[arg(long = "message", short = 'm')]
        body: Option<String>,
        /// Read markdown from a file
        #[arg(long, short = 'f')]
        file: Option<PathBuf>,
        /// Read markdown from stdin
        #[arg(long = "stdin")]
        stdin: bool,
        /// Heading slugs this edit changes (repeatable)
        #[arg(long = "block")]
        blocks: Vec<String>,
        /// Conversation this edit comes from (defaults to this Run's conversation)
        #[arg(long)]
        conversation: Option<String>,
    },
    /// Create a page (below another page with --under)
    Create {
        /// Title
        title: String,
        /// Page ID to create it under (a root page when omitted)
        #[arg(long = "under")]
        parent: Option<String>,
        /// Sibling page ID to place it after
        #[arg(long)]
        after: Option<String>,
        /// Only people given access can read it
        #[arg(long)]
        restricted: bool,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
        /// Initial markdown (defaults to the title as a heading)
        #[arg(long = "message", short = 'm')]
        body: Option<String>,
        /// Read initial markdown from a file
        #[arg(long, short = 'f')]
        file: Option<PathBuf>,
        /// Read initial markdown from stdin
        #[arg(long = "stdin")]
        stdin: bool,
    },
    /// Move a page under another page, or to the root with --root
    Move {
        /// Page ID
        page: String,
        /// Page ID to move it under
        #[arg(long = "under", conflicts_with = "root")]
        parent: Option<String>,
        /// Move it to the root of the tree
        #[arg(long)]
        root: bool,
        /// Sibling page ID to place it after
        #[arg(long)]
        after: Option<String>,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Change a page's title
    Rename {
        /// Page ID
        page: String,
        /// New title
        title: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Delete a page (move or delete its child pages first)
    Delete {
        /// Page ID
        page: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// List a page's revisions
    History {
        /// Page ID
        page: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Say that this Run's work changed nothing on the pages it works on
    Done {
        /// One line on why no page needed an update
        #[arg(long = "reason", short = 'm')]
        reason: Option<String>,
    },
    /// Link a page (or one of its sections) to a conversation
    Link {
        /// Page ID
        page: String,
        /// Heading slug
        #[arg(long)]
        block: Option<String>,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
        /// Conversation (defaults to this Run's conversation)
        #[arg(long)]
        conversation: Option<String>,
    },
    /// Claim a section you are working on, so others see it is taken; claiming again renews it
    Claim {
        /// Page ID
        page: String,
        /// Heading slug (the whole page when omitted)
        #[arg(long)]
        block: Option<String>,
        /// How long the claim lasts before it lapses, in minutes (5-1440)
        #[arg(long, default_value_t = 120)]
        minutes: u32,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Release a claim when the work is done
    Release {
        /// Page ID
        page: String,
        /// Claim ID (from `xmatrix page claim` or `xmatrix page claims`)
        claim: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Resolve a discussion once its outcome is written into the page (or reopen it)
    Resolve {
        /// Page ID
        page: String,
        /// Discussion link ID (from the `blocks:` of `xmatrix page read`)
        link: String,
        /// Reopen the discussion instead
        #[arg(long)]
        reopen: bool,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// List the claims in force on a page
    Claims {
        /// Page ID
        page: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Record your pre-review verdict on the pull request this review conversation is about
    PreReview {
        /// pass, or changes when the pull request needs changes first
        #[arg(long, value_parser = ["pass", "changes"])]
        verdict: String,
        /// One line on why, shown on the pull request's check
        #[arg(long = "message", short = 'm')]
        summary: String,
    },
    /// Draft the Space's move to pages, for a Space owner or admin to review and apply
    Migration {
        #[command(subcommand)]
        command: PageMigrationCommand,
    },
    /// A page's Automations: standing rules that keep its sections true, each referenced in its section
    #[command(alias = "automations")]
    Automation {
        #[command(subcommand)]
        command: PageAutomationCommand,
    },
}

#[derive(Subcommand)]
pub enum PageAutomationCommand {
    /// List a page's Automations with their section, cadence and state
    #[command(alias = "ls")]
    List {
        /// Page ID
        page: String,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Create an Automation in a section; it runs as your owner, in a conversation of its own.
    ///
    /// Use `@auto repo:<owner/repo>` to address an Agent each time.
    /// `--every` controls cadence. Use `pwd:"<registered-path>"` instead of
    /// `repo:` for a registered directory. Exact `@agent:N` addresses only that
    /// instance while it is live in the Automation's conversation;
    /// other live Agents receive context. Without an Agent mention, it only posts its text.
    Create {
        /// Page ID
        page: String,
        /// Heading slug of the section it keeps true (the end of the page when omitted)
        #[arg(long)]
        block: Option<String>,
        /// Its name, shown in the section
        #[arg(long)]
        name: String,
        /// How often it runs: minutes, or a number with m, h or d (e.g. 12h)
        #[arg(long)]
        every: String,
        /// Also run on an event (repeatable): merged:owner/repo[@branch][:path,…],
        /// ci-failed:owner/repo[@branch][:workflow], owed, or a connector event
        /// <connector>:<event|*>[:<source>] (e.g. sentry:issue.created:web)
        #[arg(long = "on")]
        triggers: Vec<String>,
        /// What to do each time (posted in its conversation, e.g. "@auto repo:owner/repo …")
        #[arg(long = "message", short = 'm')]
        instruction: Option<String>,
        /// Read what to do each time from a file
        #[arg(long, short = 'f')]
        file: Option<PathBuf>,
        /// Read what to do each time from stdin
        #[arg(long = "stdin")]
        stdin: bool,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Change an Automation's name, cadence or instruction; someone else's is replaced by yours
    Edit {
        /// Page ID
        page: String,
        /// Automation ID (from `xmatrix page automation list`)
        automation: String,
        /// The version you read (from `xmatrix page automation list`)
        #[arg(long)]
        version: u64,
        /// New name
        #[arg(long)]
        name: Option<String>,
        /// New cadence: minutes, or a number with m, h or d
        #[arg(long)]
        every: Option<String>,
        /// Replace its event triggers (repeatable; see `create --help`)
        #[arg(long = "on", conflicts_with = "no_triggers")]
        triggers: Vec<String>,
        /// Remove its event triggers
        #[arg(long = "no-triggers")]
        no_triggers: bool,
        /// New instruction
        #[arg(long = "message", short = 'm')]
        instruction: Option<String>,
        /// Read the new instruction from a file
        #[arg(long, short = 'f')]
        file: Option<PathBuf>,
        /// Read the new instruction from stdin
        #[arg(long = "stdin")]
        stdin: bool,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Pause an Automation; its reference stays on the page
    Pause {
        /// Page ID
        page: String,
        /// Automation ID
        automation: String,
        /// The version you read
        #[arg(long)]
        version: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Resume a paused Automation
    Resume {
        /// Page ID
        page: String,
        /// Automation ID
        automation: String,
        /// The version you read
        #[arg(long)]
        version: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Put an Automation's reference in a section, which moves it there or resumes a detached one
    Attach {
        /// Page ID
        page: String,
        /// Automation ID
        automation: String,
        /// Heading slug (the end of the page when omitted)
        #[arg(long)]
        block: Option<String>,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Delete an Automation and take its reference out of the page
    Delete {
        /// Page ID
        page: String,
        /// Automation ID
        automation: String,
        /// The version you read
        #[arg(long)]
        version: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum PageMigrationCommand {
    /// Show the Space's move to pages: its state, version and drafted page tree
    Show {
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
        /// Print the whole migration, bodies included, as JSON
        #[arg(long)]
        json: bool,
    },
    /// Submit a drafted page tree: JSON `{"pages": [{"key", "parentKey", "title", "body", "sources"}]}`
    Submit {
        /// The draft JSON file
        #[arg(long, short = 'f')]
        input: PathBuf,
        /// The draft version this replaces (from `xmatrix page migration show`; 0 when there is none)
        #[arg(long, default_value_t = 0)]
        replaces: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
    /// Publish the drafted page tree (Space owners and admins, and their Agents)
    Apply {
        /// The draft version to publish (from `xmatrix page migration show`)
        #[arg(long)]
        version: u64,
        /// Space ID (defaults to this Run's conversation's Space)
        #[arg(long)]
        space: Option<String>,
    },
}

#[cfg(test)]
mod invocation_diagnostic_args_tests {
    use super::*;
    #[test]
    fn decision_evidence_requires_a_source_message_and_supports_exact_refs() {
        for suffix in [
            vec!["--decision-evidence"],
            vec!["--decision-evidence", "ref-1"],
        ] {
            let mut args = vec!["xmatrix", "diagnose", "channel", "--message", "message"];
            args.extend(suffix);
            assert!(matches!(
                Cli::try_parse_from(args).unwrap().command,
                Some(Commands::Diagnose {
                    decision_evidence: Some(_),
                    ..
                })
            ));
        }
        assert!(
            Cli::try_parse_from(["xmatrix", "diagnose", "channel", "--decision-evidence"]).is_err()
        );
        assert!(
            Cli::try_parse_from([
                "xmatrix",
                "diagnose",
                "channel",
                "--message",
                "message",
                "--decision-evidence",
                "--run"
            ])
            .is_err()
        );
    }

    #[test]
    fn diagnosis_accepts_typed_targets_and_bounded_read_options() {
        let cli =
            Cli::try_parse_from(["xmatrix", "diagnose", "run:summon:example", "--json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Diagnose {
                run: false,
                json: true,
                limit: 20,
                ..
            })
        ));
        assert!(Cli::try_parse_from(["xmatrix", "diagnose", "channel", "--limit", "101"]).is_err());
        assert!(
            Cli::try_parse_from(["xmatrix", "diagnose", "id", "--run", "--message", "message"])
                .is_err()
        );
    }

    #[test]
    fn receipt_lookup_and_send_operation_ids_have_explicit_cli_syntax() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "diagnose",
            "channel",
            "--receipt",
            "message:1",
            "--json",
        ])
        .unwrap();
        assert!(
            matches!(cli.command, Some(Commands::Diagnose { receipt: Some(id), json: true, .. }) if id == "message:1")
        );
        for flag in ["--run", "--message"] {
            let mut args = vec![
                "xmatrix",
                "diagnose",
                "channel",
                "--receipt",
                "message:1",
                flag,
            ];
            if flag == "--message" {
                args.push("source:1");
            }
            assert!(Cli::try_parse_from(args).is_err());
        }
        let cli = Cli::try_parse_from([
            "xmatrix",
            "send",
            "channel",
            "--message-id",
            "message:1",
            "reply",
        ])
        .unwrap();
        assert!(
            matches!(cli.command, Some(Commands::Send(SendArgs { message_id: Some(id), .. })) if id == "message:1")
        );
        let cli = Cli::try_parse_from([
            "xmatrix",
            "channel",
            "send",
            "channel",
            "--message-id",
            "message:1",
            "reply",
        ])
        .unwrap();
        assert!(
            matches!(cli.command, Some(Commands::Channel { command: ChannelCommand::Send(SendArgs { message_id: Some(id), .. }) }) if id == "message:1")
        );
    }
    #[test]
    fn send_recovery_cannot_change_the_saved_operation() {
        for prefix in [
            vec!["xmatrix", "send", "channel"],
            vec!["xmatrix", "channel", "send", "channel"],
        ] {
            let mut args = prefix.clone();
            args.extend(["--recover", "message:1"]);
            let cli = Cli::try_parse_from(args.clone()).unwrap();
            let selected = match cli.command {
                Some(Commands::Send(SendArgs { recover, .. })) => recover,
                Some(Commands::Channel {
                    command: ChannelCommand::Send(SendArgs { recover, .. }),
                }) => recover,
                _ => panic!("wrong command"),
            };
            assert_eq!(selected.as_deref(), Some("message:1"));
            for extra in [
                vec!["new body"],
                vec!["--file", "new.txt"],
                vec!["--stdin"],
                vec!["--escape-newlines"],
                vec!["--message-id", "different"],
                vec!["--final-for", "11111111-1111-4111-8111-111111111111"],
            ] {
                let mut conflicting = args.clone();
                conflicting.extend(extra);
                assert_eq!(
                    Cli::try_parse_from(conflicting)
                        .err()
                        .expect("conflicting recovery input")
                        .kind(),
                    clap::error::ErrorKind::ArgumentConflict
                );
            }
        }
    }
}

#[cfg(test)]
mod registration_argument_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn management_channel_discovery_commands_parse() {
        let channels = Cli::try_parse_from([
            "xmatrix",
            "management",
            "channels",
            "--space",
            "space-1",
            "--query",
            "verification",
            "--json",
        ])
        .expect("management channels should parse");
        let Some(Commands::Management { command }) = channels.command else {
            panic!("expected a management command");
        };
        let ManagementCommand::Channels {
            space,
            query,
            limit: 50,
            json: true,
        } = *command
        else {
            panic!("expected management channels command");
        };
        assert_eq!(space, "space-1");
        assert_eq!(query, "verification");
        assert!(
            Cli::try_parse_from(["xmatrix", "management", "agents", "--space", "space-1"]).is_err(),
            "Agents are listed with `xmatrix agent list`"
        );
    }

    #[test]
    fn agent_add_names_a_harness_and_a_space() {
        let cli = Cli::try_parse_from([
            "xmatrix",
            "agent",
            "add",
            "codex",
            "--space",
            "space-1",
            "--name",
            "reviewer",
            "--arg",
            "--full-auto",
            "--workspace",
            "/repo",
        ])
        .expect("agent add should parse");
        let Some(Commands::Agent {
            command:
                AgentCommand::Add {
                    harness,
                    space,
                    name,
                    runtime: None,
                    args,
                    workspace,
                },
        }) = cli.command
        else {
            panic!("expected agent add command");
        };
        assert_eq!(harness, "codex");
        assert_eq!(space, "space-1");
        assert_eq!(name.as_deref(), Some("reviewer"));
        assert_eq!(args, vec!["--full-auto"]);
        assert_eq!(workspace, Some(PathBuf::from("/repo")));
        assert!(
            Cli::try_parse_from(["xmatrix", "agent", "add", "codex"]).is_err(),
            "add names its Space"
        );
        for removed in [
            "create",
            "edit",
            "env",
            "requests",
            "approve",
            "reject",
            "registration",
        ] {
            assert!(
                Cli::try_parse_from(["xmatrix", "agent", removed, "--space", "space-1"]).is_err(),
                "agent {removed} is gone"
            );
        }
    }

    #[test]
    fn agent_remove_defaults_to_the_callers_agent_on_this_machine() {
        let cli =
            Cli::try_parse_from(["xmatrix", "agent", "remove", "claude", "--space", "space-1"])
                .expect("agent remove should parse");
        let Some(Commands::Agent {
            command:
                AgentCommand::Remove {
                    harness,
                    space,
                    owner: None,
                    machine: None,
                },
        }) = cli.command
        else {
            panic!("expected agent remove command");
        };
        assert_eq!((harness.as_str(), space.as_str()), ("claude", "space-1"));
    }
}

/// Arguments shared by `send` and `channel send`.
#[derive(clap::Args)]
pub struct SendArgs {
    /// Channel ID or xmatrix.sh channel URL
    pub channel_id: String,
    /// Reuse this stable message ID for the same send operation
    #[arg(long)]
    pub message_id: Option<String>,
    /// Declare this message as the final reply for an explicit runtime execution UUID
    #[arg(long)]
    pub final_for: Option<String>,
    /// Reply to this message ID. A reply to a cross-Channel link message is relayed back to the Channel the link came from.
    #[arg(long, value_name = "MESSAGE_ID")]
    pub reply_to: Option<String>,
    /// Recover a saved send by checking its receipt before retrying the same message
    #[arg(long, conflicts_with_all = ["message_id", "final_for", "reply_to", "files", "stdin", "escape_newlines", "message"])]
    pub recover: Option<String>,
    /// File attachment path. Repeat for multiple files.
    #[arg(long = "file")]
    pub files: Vec<PathBuf>,
    /// Read the full message body from stdin. Use this for multi-line Markdown.
    #[arg(long)]
    pub stdin: bool,
    /// Decode literal \n and \r\n sequences in the message arguments into real newlines.
    #[arg(long)]
    pub escape_newlines: bool,
    /// Message body
    pub message: Vec<String>,
}
