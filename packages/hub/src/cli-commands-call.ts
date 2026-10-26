import { HUB_ROUTES } from "@xmatrix/protocol";
import type { ConnectorActionResult } from "./connectors/provider";
import type { CliCommand } from "./cli-commands";

export const CONNECTOR_CALL_COMMAND: CliCommand = {
  path: ["call"], about: "Call a connected app read action with public or private results",
  positionals: [{ name: "command", help: 'A quoted connector command, e.g. "@gmail:read:<message id>". The invocation and parameters are visible in the Channel in both modes.' }],
  options: [{ name: "private", kind: "flag", help: "Mask the shared result; the calling Agent and its Human owner can read the original" },
    { name: "public", kind: "flag", help: "Publish the result normally in the Channel" },
    { name: "json", kind: "flag", help: "Print the caller's original result as JSON" }],
  async run(call, { positionals, options }) {
    // Bare calls used to promise no Channel persistence. Never silently make
    // those scripts publish parameters or results after a Hub update.
    if (Boolean(options.private) === Boolean(options.public)) return { stdout: "", exitCode: 2,
      stderr: "Choose exactly one of --private or --public. Both record invocation parameters in the Channel; --private masks only the result.\n" };
    const result = await call("POST", HUB_ROUTES.connector_call, { command: positionals.command,
      resultVisibility: options.private ? "private" : "public" }) as ConnectorActionResult;
    return { stdout: options.json ? `${JSON.stringify(result)}\n`
      : `${result.summary}${result.url ? `\n${result.url}` : ""}\n` };
  },
};
