# Commands the Hub defines

Part of the thin CLI (page:4106ee48-966c-43bf-8c16-5b0f64e590a5): a product
command whose work is all on the Hub is defined there, so its syntax, help and
output change with a Hub deploy instead of a CLI release.

## Flow

1. `xmatrix <word> …` where `<word>` is not a command compiled into the CLI
   reaches clap's external-subcommand passthrough.
2. If `<word>` is a plain lowercase word, names no harness launcher and is not
   the runtime this process was spawned to run (`XMATRIX_SPAWN_RUNTIME`), the
   CLI sends the whole command line to `POST /api/cli/commands/run`
   `{ argv }` with the caller's credential (`runtime_hub_command.rs`).
3. The Hub (`packages/hub/src/cli-commands.ts`) parses it against its command
   table: `--name value`, `--name=value`, flags, positionals, required options,
   integer values, `--help` on a group or command. It returns
   `{ stdout, stderr?, exitCode }`, or `{ unknownCommand: true }`, after which
   the CLI reports the word as an unknown command with clap's usual
   suggestion.
4. A command acts only by calling the Hub's own routes in-process with the
   caller's request headers (credential, client version, cell), so it reaches
   exactly what the caller could reach by calling those routes; the Agent Run
   route allowlist still applies to each call.

`xmatrix --help` ends with a pointer to `xmatrix commands`, itself a Hub
command that lists what the Hub defines.

## What stays in the CLI

Commands that touch the machine (login and credentials, daemon, workspaces,
harness processes, local files and stdin, attachments, update) and the ones not
yet moved. Offline, a Hub command fails with the connection error; local
commands keep working.

## Moved so far

- `automation list|update|pause|resume|cancel-execution|delete`
  (`cli-commands-automation.ts`). Output is unchanged.

Moving another command: add it to the Hub table with the same options and
output, delete its clap definition and handler from the CLI. Older CLIs keep
their compiled copy.
