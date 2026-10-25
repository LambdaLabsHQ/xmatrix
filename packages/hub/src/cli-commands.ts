/**
 * `xmatrix` commands the Hub defines (docs/architecture/hub-cli-commands.md).
 *
 * The CLI sends a word it does not know, with the rest of its argv and any stdin it was told to
 * read, to `POST /api/cli/commands/run`; the Hub parses it, answers it and returns what to print.
 * A command here changes with a Hub deploy. Each one acts only through the Hub's own routes, called
 * with the caller's credential, so a command never reaches what that caller could not.
 */

export interface CliOption {
  /** Long name without dashes. */
  name: string;
  aliases?: string[];
  /** A flag takes no value. */
  kind: "string" | "integer" | "flag";
  required?: boolean;
  help: string;
}

export interface CliCommand {
  /** Words after `xmatrix`, e.g. ["automation", "list"]. */
  path: string[];
  about: string;
  positionals?: Array<{ name: string; help: string }>;
  options?: CliOption[];
  run(call: CliCall, args: CliArgs): Promise<CliOutput>;
}

export interface CliArgs {
  positionals: Record<string, string>;
  options: Record<string, string | number | boolean>;
}

export interface CliOutput { stdout: string; stderr?: string; exitCode?: number }

/** One request to a Hub route as the caller. Resolves to the parsed JSON body, or throws CliRouteError. */
export type CliCall = (method: string, route: string, body?: unknown) => Promise<unknown>;

export class CliRouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const usageError = (message: string, usage: string): CliOutput =>
  ({ stdout: "", stderr: `error: ${message}\n\n${usage}\n\nFor more information, try '--help'.\n`, exitCode: 2 });

function usageLine(command: CliCommand): string {
  const positionals = (command.positionals ?? []).map((positional) => `<${positional.name.toUpperCase()}>`);
  const required = (command.options ?? []).filter((option) => option.required)
    .map((option) => `--${option.name} <${option.name.toUpperCase()}>`);
  return `Usage: xmatrix ${command.path.join(" ")} [OPTIONS] ${[...required, ...positionals].join(" ")}`.trimEnd();
}

function commandHelp(command: CliCommand): string {
  const lines = [command.about, "", usageLine(command)];
  if (command.positionals?.length) {
    lines.push("", "Arguments:");
    for (const positional of command.positionals) lines.push(`  <${positional.name.toUpperCase()}>  ${positional.help}`);
  }
  lines.push("", "Options:");
  for (const option of command.options ?? []) {
    const value = option.kind === "flag" ? "" : ` <${option.name.toUpperCase()}>`;
    const aliases = option.aliases?.length ? ` [aliases: ${option.aliases.map((alias) => `--${alias}`).join(", ")}]` : "";
    lines.push(`      --${option.name}${value}  ${option.help}${option.required ? " (required)" : ""}${aliases}`);
  }
  lines.push("  -h, --help  Print help");
  return `${lines.join("\n")}\n`;
}

function groupHelp(commands: CliCommand[], prefix: string[], about: string | undefined): string {
  const children = new Map<string, string>();
  for (const command of commands) {
    if (command.path.length <= prefix.length || !prefix.every((word, index) => command.path[index] === word)) continue;
    const word = command.path[prefix.length]!;
    if (!children.has(word)) children.set(word, command.path.length === prefix.length + 1 ? command.about : "");
  }
  const width = Math.max(4, ...[...children.keys()].map((word) => word.length));
  const lines = [...(about ? [about, ""] : []),
    `Usage: xmatrix ${[...prefix, "<COMMAND>"].join(" ")}`, "", "Commands:"];
  for (const [word, text] of children) lines.push(`  ${word.padEnd(width)}  ${text}`.trimEnd());
  return `${lines.join("\n")}\n`;
}

/** Parses `argv` (after the command's words) against `command`; a string is a usage error. */
function parseArgs(command: CliCommand, argv: string[]): CliArgs | string {
  const args: CliArgs = { positionals: {}, options: {} };
  const options = command.options ?? [];
  const positionals = command.positionals ?? [];
  const byName = new Map<string, CliOption>();
  for (const option of options) for (const name of [option.name, ...option.aliases ?? []]) byName.set(name, option);
  let next = 0;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word.startsWith("--") && word.length > 2) {
      const [name, inline] = word.slice(2).split(/=(.*)/su, 2) as [string, string | undefined];
      const option = byName.get(name);
      if (!option) return `unexpected argument '--${name}' found`;
      if (option.name in args.options) return `the argument '--${option.name}' cannot be used multiple times`;
      if (option.kind === "flag") {
        if (inline !== undefined) return `unexpected value '${inline}' for '--${option.name}' found`;
        args.options[option.name] = true;
        continue;
      }
      const value = inline ?? argv[++index];
      if (value === undefined) return `a value is required for '--${option.name} <${option.name.toUpperCase()}>' but none was supplied`;
      if (option.kind === "integer") {
        if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
          return `invalid value '${value}' for '--${option.name} <${option.name.toUpperCase()}>': not a whole number`;
        }
        args.options[option.name] = Number(value);
      } else {
        args.options[option.name] = value;
      }
      continue;
    }
    const positional = positionals[next++];
    if (!positional) return `unexpected argument '${word}' found`;
    args.positionals[positional.name] = word;
  }
  const missing = [
    ...positionals.filter((positional) => !(positional.name in args.positionals)).map((positional) => `<${positional.name.toUpperCase()}>`),
    ...options.filter((option) => option.required && !(option.name in args.options)).map((option) => `--${option.name} <${option.name.toUpperCase()}>`),
  ];
  if (missing.length) return `the following required arguments were not provided:\n  ${missing.join("\n  ")}`;
  return args;
}

/** Runs `argv` (the words after `xmatrix`) against `commands`; `null` when no command is named, so
 * the CLI reports the word as unknown the way it reports any other. */
export async function runCliCommand(commands: CliCommand[], groups: Record<string, string>, argv: string[],
  call: CliCall): Promise<CliOutput | null> {
  const help = argv.includes("--help") || argv.includes("-h");
  const words = argv.filter((word) => word !== "--help" && word !== "-h");
  let command: CliCommand | undefined;
  for (const candidate of commands) {
    if (candidate.path.every((word, index) => words[index] === word) &&
        (!command || candidate.path.length > command.path.length)) command = candidate;
  }
  if (!command) {
    // A group word alone (or with --help) lists what it holds.
    const prefix: string[] = [];
    for (const word of words) {
      const longer = [...prefix, word];
      if (!commands.some((candidate) => longer.every((part, index) => candidate.path[index] === part))) break;
      prefix.push(word);
    }
    if (!prefix.length) return null;
    const listing = groupHelp(commands, prefix, groups[prefix.join(" ")]);
    if (help || words.length === prefix.length) return { stdout: listing, exitCode: help ? 0 : 2 };
    return usageError(`unrecognized subcommand '${words[prefix.length]}'`, `Usage: xmatrix ${prefix.join(" ")} <COMMAND>`);
  }
  if (help) return { stdout: commandHelp(command) };
  const args = parseArgs(command, words.slice(command.path.length));
  if (typeof args === "string") return usageError(args, usageLine(command));
  try {
    return await command.run(call, args);
  } catch (error) {
    if (error instanceof CliRouteError) return { stdout: "", stderr: `error: ${error.message}\n`, exitCode: 1 };
    throw error;
  }
}

/** The groups and commands the Hub defines, for `xmatrix commands`. */
export function commandsListing(commands: CliCommand[], groups: Record<string, string>): string {
  const lines = ["Commands defined by the Hub (run `xmatrix <command> --help` for each):", ""];
  const width = Math.max(...commands.map((command) => command.path.join(" ").length));
  for (const [group, about] of Object.entries(groups)) lines.push(`  ${group.padEnd(width)}  ${about}`);
  for (const command of commands) lines.push(`  ${command.path.join(" ").padEnd(width)}  ${command.about}`);
  return `${lines.join("\n")}\n`;
}
