#![deny(warnings)]

use clap::{CommandFactory, FromArgMatches};
use colored::Colorize;
use xmatrix_cli_args::Cli;

fn main() {
    xmatrix_cli_core::version::register(env!("CARGO_PKG_VERSION"));
    // Clap's derived command tree exceeds the 1 MiB default Windows main-thread
    // stack in debug builds, so construct the Tokio runtime and CLI on a
    // deliberately sized thread there.
    #[cfg(windows)]
    std::thread::Builder::new()
        .name("xmatrix-main".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(run_main)
        .expect("failed to start xmatrix main thread")
        .join()
        .expect("xmatrix main thread panicked");

    #[cfg(not(windows))]
    run_main();
}

#[tokio::main]
async fn run_main() {
    xmatrix_cli_runtime::configure_process_utf8();
    if let Some(result) = xmatrix_cli_runtime::maybe_run_update_handoff_from_env() {
        if let Err(error) = result {
            eprintln!("{} {error}", "update handoff error:".red().bold());
            std::process::exit(1);
        }
        return;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();

    // The binary alone carries the release version (see xmatrix_cli_core::version).
    let matches = Cli::command()
        .version(xmatrix_cli_core::version::current())
        .get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|error| error.exit());
    if let Some(error) = xmatrix_cli_runtime::unknown_command_error(&cli) {
        error.exit();
    }
    let result = xmatrix_cli_runtime::run(cli).await;

    if let Err(e) = result {
        eprintln!("{} {e}", "error:".red().bold());
        std::process::exit(1);
    }
}
