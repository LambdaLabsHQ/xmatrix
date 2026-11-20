use clap::{CommandFactory, FromArgMatches};
use colored::Colorize;
use xmatrix_cli_args::Cli;

/// Full CLI entrypoint living inside `xmatrix-cli-runtime` (`version = "0.0.0"`).
/// Keeping `tokio::main`, `clap`, `rustls`, and the top-level `async fn run`
/// future inside the `0.0.0` library crate prevents release version bumps on
/// the root `xmatrix` binary crate from re-monomorphizing and re-optimizing
/// them on every beta and stable tag.
pub fn entrypoint(version: &'static str) {
    if let Some(result) = crate::maybe_run_utf8_shell() {
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                std::eprintln!("UTF-8 shell: {error}");
                std::process::exit(1);
            }
        }
    }
    xmatrix_cli_core::version::register(version);
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
    crate::configure_process_utf8();
    if let Some(result) = crate::maybe_run_update_handoff_from_env() {
        if let Err(error) = result {
            std::eprintln!("{} {error}", "update handoff error:".red().bold());
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
    if let Some(error) = crate::unknown_command_error(&cli) {
        error.exit();
    }
    let result = crate::run(cli).await;

    if let Err(e) = result {
        std::eprintln!("{} {e}", "error:".red().bold());
        std::process::exit(1);
    }
}
