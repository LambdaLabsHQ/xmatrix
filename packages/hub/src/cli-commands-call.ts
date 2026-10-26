import { HUB_ROUTES } from "@xmatrix/protocol";
import type { ConnectorActionResult } from "./connectors/provider";
import type { CliCommand } from "./cli-commands";

export const CONNECTOR_CALL_COMMAND: CliCommand = {
  path: ["call"], about: "Call a connected app read action privately; only this caller receives the result",
  positionals: [{ name: "command", help: 'A quoted connector command, e.g. "@gmail:read:<message id>". Parameters and results stay out of the Channel.' }],
  options: [{ name: "json", kind: "flag", help: "Print the private result as JSON" }],
  async run(call, { positionals, options }) {
    const result = await call("POST", HUB_ROUTES.connector_call, { command: positionals.command }) as ConnectorActionResult;
    return { stdout: options.json ? `${JSON.stringify(result)}\n`
      : `${result.summary}${result.url ? `\n${result.url}` : ""}\n` };
  },
};
