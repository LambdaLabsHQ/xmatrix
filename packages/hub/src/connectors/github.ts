import { getAppConnectorProvider } from "../app-connectors";
import { dispatchProductGitHubConnectorAfterAuthorityMessage } from "../product-github-connector-authority-adapter";
import { parseActionCommand } from "./action-parse";
import { publishCommandStatus } from "./command-support";
import { runPolicy } from "./connector-commands";
import { isGitHubConnectorCommand } from "./github-command";
import type { ConnectorProvider } from "./provider";

export const githubConnectorProvider: ConnectorProvider = {
  id: "github",
  commands: {
    accepts: isGitHubConnectorCommand,
    run: async (input) => {
      const parsed = parseActionCommand("github", input.body);
      if (parsed?.actionId !== "policy") return dispatchProductGitHubConnectorAfterAuthorityMessage(input);
      await publishCommandStatus(getAppConnectorProvider("github")!, input,
        [await runPolicy("github", input, parsed.statement)]);
    },
  },
};
